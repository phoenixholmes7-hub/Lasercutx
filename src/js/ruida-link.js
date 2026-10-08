// Sends Ruida jobs to the laser: Ethernet (desktop app, UDP) or USB cable
// (Web Serial – desktop app, Chrome, Edge).
//
// USB facts (from the MeerK40t / VisiCut notes on Ruida RDC644x controllers):
// the port is an FTDI USB-serial chip (VID 0x0403, PID 0x6001), 8N1 with
// RTS/CTS hardware flow control and DTR on; no checksums and no ACKs. A
// "read memory" request (DA 00 <addr>) is answered with DA 01 <addr> <value>,
// which is how a connection is proven and how status/position are polled.
import { swizzle, swizzleByte, unswizzle, udpPackets, ACK, ENQ, enc32 } from './ruida.js';

const desktop = typeof window !== 'undefined' ? window.lcx : null;

export const networkSupported = () => !!desktop?.ruida;
export const usbSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

// Real-time process commands (work over both links).
export const STOP = [0xd8, 0x01];
export const PAUSE = [0xd8, 0x02];
export const RESUME = [0xd8, 0x03];

// Controller memory addresses
export const MEM = {
  cardId: [0x05, 0x7e],
  status: [0x04, 0x00],
  x: [0x04, 0x21],
  y: [0x04, 0x31],
  bedX: [0x00, 0x26],
  bedY: [0x00, 0x36],
};
const STATUS_RUNNING = 0x00000001;
const STATUS_PART_END = 0x00000002;
const STATUS_MOVING = 0x01000000;

const FTDI = { vendor: 0x0403, product: 0x6001 };
const MAGICS = [0x88, 0x11, 0x38];
const USB_TRIES = [
  { baudRate: 921600, flowControl: 'hardware' },
  { baudRate: 115200, flowControl: 'hardware' },
  { baudRate: 921600, flowControl: 'none' },
  { baudRate: 115200, flowControl: 'none' },
  { baudRate: 38400, flowControl: 'none' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeU35(b) {
  return ((b[0] & 0x7f) * 2 ** 28) + ((b[1] & 0x7f) << 21) + ((b[2] & 0x7f) << 14) + ((b[3] & 0x7f) << 7) + (b[4] & 0x7f);
}

export function statusLabel(v) {
  if (v & STATUS_MOVING) return 'Moving';
  if (v & STATUS_PART_END) return 'Finishing';
  if (v & STATUS_RUNNING) return 'Running job';
  return 'Idle';
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem('lcx.ruidaUsb') || '{}');
  } catch {
    return {};
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem('lcx.ruidaUsb', JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

export class RuidaLink {
  constructor({ onStatus = () => {}, onLog = () => {}, onState = () => {} } = {}) {
    this.onStatus = onStatus;
    this.onLog = onLog;
    this.onState = onState;
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.rx = []; // unswizzled bytes received over USB
    this.magic = 0x88;
    this.usbSettings = null;
    this.sending = false;
    this.cancelled = false;
    this.pollTimer = null;
    this.busyQuery = false;
    this.connecting = false;
  }

  get usbConnected() {
    return !!this.writer && !!this.usbSettings;
  }

  // ---------- USB ----------

  // Ports the user already allowed (desktop app: any serial port).
  async knownPorts() {
    if (!usbSupported()) return [];
    try {
      return await navigator.serial.getPorts();
    } catch {
      return [];
    }
  }

  // Picks the laser among allowed ports: the one used last time, else an FTDI
  // chip (what Ruida controllers use), else the only port there is.
  async findPort() {
    const ports = await this.knownPorts();
    if (!ports.length) return null;
    const pref = loadPrefs();
    const info = (p) => p.getInfo?.() || {};
    return (
      ports.find((p) => pref.vendor && info(p).usbVendorId === pref.vendor && info(p).usbProductId === pref.product) ||
      ports.find((p) => info(p).usbVendorId === FTDI.vendor && info(p).usbProductId === FTDI.product) ||
      (ports.length === 1 ? ports[0] : null)
    );
  }

  // Silent connect (no picker). Used on start-up and when the cable is plugged in.
  async autoConnect() {
    if (this.usbConnected || this.connecting) return this.usbConnected;
    const port = await this.findPort();
    if (!port) return false;
    try {
      await this.connectPort(port);
      return true;
    } catch (e) {
      this.onLog(`Auto-connect: ${e.message}`);
      return false;
    }
  }

  // Connect with the port picker (first time) – or silently if possible.
  async connectUsb() {
    if (!usbSupported()) throw new Error('This browser cannot use USB devices. Use the desktop app, Chrome or Edge.');
    let port = await this.findPort();
    if (!port) port = await navigator.serial.requestPort();
    await this.connectPort(port);
  }

  async connectPort(port) {
    this.connecting = true;
    this.onState('Connecting…');
    try {
      const pref = loadPrefs();
      // try what worked last time first
      const tries = pref.baudRate ? [{ baudRate: pref.baudRate, flowControl: pref.flowControl }, ...USB_TRIES] : USB_TRIES;
      const magics = pref.magic ? [pref.magic, ...MAGICS.filter((m) => m !== pref.magic)] : MAGICS;
      for (const t of tries) {
        await this.openPort(port, t);
        for (const magic of magics) {
          this.magic = magic;
          const card = await this.query(MEM.cardId, 700).catch(() => null);
          if (card !== null) {
            const info = port.getInfo?.() || {};
            this.usbSettings = { ...t, magic };
            savePrefs({ ...t, magic, vendor: info.usbVendorId, product: info.usbProductId });
            this.onLog(`✓ Laser answered over USB (${t.baudRate} baud, ${t.flowControl === 'hardware' ? 'RTS/CTS' : 'no flow control'}, controller id 0x${card.toString(16).toUpperCase()})`);
            this.onState('Connected');
            this.startPolling();
            return;
          }
        }
        await this.closePort();
      }
      throw new Error(
        'The laser did not answer over USB. Check it is switched on, the cable is in the controller’s USB port (not the U-disk slot), close LightBurn/RDWorks, and on Windows install the FTDI/Ruida USB driver.'
      );
    } finally {
      this.connecting = false;
      if (!this.usbSettings) this.onState('Disconnected');
    }
  }

  async openPort(port, { baudRate, flowControl }) {
    await this.closePort();
    await port.open({ baudRate, flowControl, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 8192 });
    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch {
      /* not supported on every platform */
    }
    this.port = port;
    this.writer = port.writable.getWriter();
    this.rx = [];
    const reader = port.readable.getReader();
    this.reader = reader;
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this.rx.push(...unswizzle(value, this.magic));
        }
      } catch {
        /* port closed or unplugged */
      }
    })();
  }

  async closePort() {
    this.stopPolling();
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock();
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = this.writer = this.reader = null;
  }

  async disconnectUsb() {
    await this.closePort();
    this.usbSettings = null;
    this.onState('Disconnected');
  }

  // Writes raw (unswizzled) bytes, with a time limit so a stalled port can't hang the app.
  async usbWrite(bytes, timeoutMs = 4000) {
    if (!this.writer) throw new Error('USB not connected');
    const data = swizzle(bytes, this.magic);
    await Promise.race([
      this.writer.write(data),
      sleep(timeoutMs).then(() => {
        throw new Error('USB write timed out');
      }),
    ]);
  }

  // Reads one controller memory value over USB. Resolves with the number.
  async query(addr, timeoutMs = 800) {
    if (!this.writer) throw new Error('USB not connected');
    this.rx = [];
    await this.usbWrite([0xda, 0x00, ...addr], 1500);
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      // a reply is DA 01 <addr hi> <addr lo> <5-byte value> …
      for (let i = 0; i + 8 < this.rx.length; i++) {
        if (this.rx[i] === 0xda && this.rx[i + 1] === 0x01 && this.rx[i + 2] === addr[0] && this.rx[i + 3] === addr[1]) {
          return decodeU35(this.rx.slice(i + 4, i + 9));
        }
      }
      await sleep(20);
    }
    throw new Error('no reply');
  }

  startPolling() {
    this.stopPolling();
    const tick = async () => {
      if (!this.usbConnected || this.sending || this.busyQuery) return;
      this.busyQuery = true;
      try {
        const st = await this.query(MEM.status, 600);
        const x = await this.query(MEM.x, 600);
        const y = await this.query(MEM.y, 600);
        this.missed = 0;
        this.onStatus({ state: statusLabel(st), x: x / 1000, y: y / 1000 });
      } catch {
        this.missed = (this.missed || 0) + 1;
        if (this.missed >= 3) this.onStatus({ state: 'Not answering' });
      } finally {
        this.busyQuery = false;
      }
    };
    this.pollTimer = setInterval(tick, 1000);
    tick();
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // ---------- network ----------

  // Is the laser answering on the network? Also detects the swizzle magic.
  async ping(host) {
    if (!networkSupported()) throw new Error('Network sending needs the LaserCutX desktop app.');
    for (const magic of [this.magic, ...MAGICS.filter((m) => m !== this.magic)]) {
      const pkt = udpPackets(swizzle([ENQ], magic))[0];
      const r = await desktop.ruida.ping(host, pkt);
      if (!r.ok) throw new Error(r.error);
      if (r.reply === swizzleByte(ACK, magic)) {
        this.magic = magic;
        return true;
      }
    }
    throw new Error(`Something answered at ${host}, but not like a Ruida controller.`);
  }

  // ---------- jobs & commands (both links) ----------

  // bytes: unswizzled job; via: 'network' | 'usb'
  async send(bytes, { via, host, onProgress = () => {} }) {
    if (this.sending) throw new Error('Already sending a job.');
    this.sending = true;
    this.cancelled = false;
    try {
      if (via === 'network') {
        if (!networkSupported()) throw new Error('Network sending needs the LaserCutX desktop app.');
        if (!host) throw new Error('Enter the laser’s IP address first.');
        desktop.ruida.onProgress(onProgress);
        const data = swizzle(bytes, this.magic);
        const r = await desktop.ruida.send(host, udpPackets(data), swizzleByte(ACK, this.magic));
        if (!r.ok) throw new Error(r.error);
      } else {
        if (!this.usbConnected) throw new Error('Connect the laser by USB first.');
        // wait for a status poll in progress to finish
        while (this.busyQuery) await sleep(20);
        const CHUNK = 512;
        const paced = this.usbSettings.flowControl !== 'hardware';
        const msPerChunk = paced ? Math.ceil(((CHUNK * 10) / this.usbSettings.baudRate) * 1000 * 1.5) : 0;
        for (let i = 0; i < bytes.length; i += CHUNK) {
          if (this.cancelled) throw new Error('Cancelled');
          await this.usbWrite(bytes.subarray(i, i + CHUNK), 15000);
          if (msPerChunk) await sleep(msPerChunk);
          onProgress(Math.min(1, (i + CHUNK) / bytes.length));
        }
      }
    } finally {
      this.sending = false;
    }
  }

  // Short command (stop / pause / resume).
  async command(cmd, { via, host }) {
    if (via === 'network') {
      if (this.sending) {
        this.cancelled = true;
        await desktop.ruida.cancel();
        await sleep(150); // the upload holds the port; let it go
      }
      const r = await desktop.ruida.ping(host, udpPackets(swizzle(cmd, this.magic))[0]);
      if (!r.ok) throw new Error(r.error);
    } else {
      if (!this.usbConnected) throw new Error('Not connected.');
      this.cancelled = true;
      await this.usbWrite(cmd);
    }
  }
}

export { enc32 };
