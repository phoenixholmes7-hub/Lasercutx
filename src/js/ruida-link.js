// Sends Ruida jobs to the laser: Ethernet (desktop app, UDP) or USB cable
// (Web Serial – desktop app, Chrome, Edge).
import { swizzle, swizzleByte, udpPackets, ACK, ENQ } from './ruida.js';

const desktop = typeof window !== 'undefined' ? window.lcx : null;

export const networkSupported = () => !!desktop?.ruida;
export const usbSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

// Real-time process commands (work over both links).
export const STOP = [0xd8, 0x01];
export const PAUSE = [0xd8, 0x02];
export const RESUME = [0xd8, 0x03];

export class RuidaLink {
  constructor() {
    this.port = null; // USB serial port
    this.writer = null;
    this.sending = false;
    this.cancelled = false;
  }

  get usbConnected() {
    return !!this.writer;
  }

  async connectUsb() {
    if (!usbSupported()) throw new Error('This browser cannot use USB devices. Use the desktop app, Chrome or Edge.');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.writer = port.writable.getWriter();
    // drain anything the controller says so its buffer never fills
    this.reading = (async () => {
      try {
        const reader = port.readable.getReader();
        this.reader = reader;
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* closed */
      }
    })();
  }

  async disconnectUsb() {
    try {
      await this.reader?.cancel();
      this.writer?.releaseLock();
      await this.port?.close();
    } catch {
      /* already closed */
    }
    this.port = this.writer = this.reader = null;
  }

  // Is the laser answering on the network?
  async ping(host) {
    if (!networkSupported()) throw new Error('Network sending needs the LaserCutX desktop app.');
    const pkt = udpPackets(swizzle([ENQ]))[0];
    const r = await desktop.ruida.ping(host, pkt);
    if (!r.ok) throw new Error(r.error);
    return true;
  }

  // bytes: unswizzled job; via: 'network' | 'usb'
  async send(bytes, { via, host, onProgress = () => {} }) {
    if (this.sending) throw new Error('Already sending a job.');
    this.sending = true;
    this.cancelled = false;
    const data = swizzle(bytes);
    try {
      if (via === 'network') {
        if (!networkSupported()) throw new Error('Network sending needs the LaserCutX desktop app.');
        if (!host) throw new Error('Enter the laser’s IP address first.');
        desktop.ruida.onProgress(onProgress);
        const r = await desktop.ruida.send(host, udpPackets(data), swizzleByte(ACK));
        if (!r.ok) throw new Error(r.error);
      } else {
        if (!this.writer) throw new Error('Connect the USB cable first.');
        const CHUNK = 1024;
        for (let i = 0; i < data.length; i += CHUNK) {
          if (this.cancelled) throw new Error('Cancelled');
          await this.writer.write(data.subarray(i, i + CHUNK));
          onProgress(Math.min(1, (i + CHUNK) / data.length));
        }
      }
    } finally {
      this.sending = false;
    }
  }

  // Short command (stop / pause / resume).
  async command(cmd, { via, host }) {
    const data = swizzle(cmd);
    if (via === 'network') {
      if (this.sending) {
        this.cancelled = true;
        await desktop.ruida.cancel();
      }
      // the job upload holds the port; give it a moment to let go
      await new Promise((r) => setTimeout(r, 150));
      const r = await desktop.ruida.ping(host, udpPackets(data)[0]);
      if (!r.ok) throw new Error(r.error);
    } else if (this.writer) {
      this.cancelled = true;
      await this.writer.write(data);
    } else {
      throw new Error('Not connected.');
    }
  }
}
