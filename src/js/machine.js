// Direct control of GRBL-based lasers over USB (Web Serial API).
// Works in the desktop app and in Chrome / Edge. Streams G-code line by line,
// waiting for GRBL's "ok" before sending the next one.

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export class Grbl {
  constructor({ onStatus, onLog, onState } = {}) {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buffer = '';
    this.waiters = []; // resolve functions waiting for ok / error
    this.status = { state: 'Disconnected', x: 0, y: 0 };
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || (() => {});
    this.onState = onState || (() => {});
    this.job = null;
    this.poll = null;
  }

  get connected() {
    return !!this.port;
  }

  async connect(baudRate = 115200) {
    if (!serialSupported()) throw new Error('This browser cannot talk to USB devices. Use the desktop app, Chrome or Edge.');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.readLoop();
    // wake GRBL up and ask for its version
    await this.writeRaw('\r\n\r\n');
    await new Promise((r) => setTimeout(r, 300));
    this.send('$I').catch(() => {});
    this.poll = setInterval(() => this.realtime('?'), 300);
    this.setState('Connected');
  }

  async disconnect() {
    clearInterval(this.poll);
    this.poll = null;
    this.job = null;
    try {
      await this.reader?.cancel();
    } catch {
      /* port already gone */
    }
    try {
      this.writer?.releaseLock();
      await this.port?.close();
    } catch {
      /* port already gone */
    }
    this.port = this.reader = this.writer = null;
    this.failWaiters('Disconnected');
    this.status = { state: 'Disconnected', x: 0, y: 0 };
    this.onStatus(this.status);
    this.setState('Disconnected');
  }

  setState(s) {
    this.onState(s);
  }

  async readLoop() {
    const decoder = new TextDecoder();
    while (this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          let i;
          while ((i = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, i).trim();
            this.buffer = this.buffer.slice(i + 1);
            if (line) this.handleLine(line);
          }
        }
      } catch (e) {
        this.onLog(`! ${e.message}`);
        break;
      } finally {
        this.reader?.releaseLock();
      }
    }
    if (this.port) this.disconnect();
  }

  handleLine(line) {
    if (line.startsWith('<')) {
      // <Idle|MPos:0.000,0.000,0.000|FS:0,0|WCO:...>
      const parts = line.slice(1, -1).split('|');
      const st = { state: parts[0].split(':')[0], x: this.status.x, y: this.status.y };
      for (const p of parts) {
        const [k, v] = p.split(':');
        if (k === 'WPos' || k === 'MPos') {
          const [x, y] = v.split(',').map(Number);
          st.x = x;
          st.y = y;
          if (k === 'MPos' && this.wco) {
            st.x -= this.wco[0];
            st.y -= this.wco[1];
          }
        }
        if (k === 'WCO') this.wco = v.split(',').map(Number);
      }
      this.status = st;
      this.onStatus(st);
      return;
    }
    if (line === 'ok') return this.resolveNext(null);
    if (line.startsWith('error')) {
      this.onLog(`← ${line}`);
      return this.resolveNext(line);
    }
    if (line.startsWith('ALARM')) {
      this.onLog(`← ${line} (use Unlock or Home)`);
      this.failWaiters(line);
      if (this.job) this.job.alarm = line;
      return;
    }
    this.onLog(`← ${line}`);
  }

  resolveNext(err) {
    const w = this.waiters.shift();
    if (w) w(err);
  }

  failWaiters(reason) {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w(reason);
  }

  async writeRaw(text) {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(new TextEncoder().encode(text));
  }

  // Real-time commands bypass GRBL's queue: ? status, ! hold, ~ resume, 0x18 reset, 0x85 jog cancel.
  async realtime(ch) {
    if (!this.writer) return;
    try {
      await this.writeRaw(ch);
    } catch {
      /* ignore while disconnecting */
    }
  }

  // Sends one line and waits for ok (rejects on error / alarm).
  send(line) {
    return new Promise((resolve, reject) => {
      this.waiters.push((err) => (err ? reject(new Error(err)) : resolve()));
      this.writeRaw(`${line}\n`).catch((e) => {
        this.waiters.pop();
        reject(e);
      });
      if (!this.job) this.onLog(`→ ${line}`);
    });
  }

  home() {
    return this.send('$H');
  }

  unlock() {
    return this.send('$X');
  }

  // Makes the current laser position the job's (0,0).
  setOrigin() {
    return this.send('G10 L20 P1 X0 Y0');
  }

  jog(dx, dy, feed = 3000) {
    return this.send(`$J=G91 G21 X${dx} Y${dy} F${feed}`);
  }

  // Traces the job's bounding box with the laser off (or a very low power
  // "pointer" if the machine has none) so you can check placement.
  async frame(w, h, { feed = 3000, lowPower = 0 } = {}) {
    const cmds =
      lowPower > 0
        ? ['G90', 'G0 X0 Y0', `M3 S${lowPower}`, `G1 X${w} Y0 F${feed}`, `G1 X${w} Y${h}`, `G1 X0 Y${h}`, 'G1 X0 Y0', 'M5 S0']
        : ['G90', `G0 X0 Y0`, `G0 X${w} Y0`, `G0 X${w} Y${h}`, `G0 X0 Y${h}`, 'G0 X0 Y0'];
    for (const c of cmds) await this.send(c);
  }

  // Streams a whole job. onProgress(done, total).
  async run(gcode, onProgress = () => {}) {
    if (this.job) throw new Error('A job is already running');
    const lines = gcode
      .split('\n')
      .map((l) => l.replace(/;.*$/, '').trim())
      .filter(Boolean);
    const job = (this.job = { stopped: false, paused: false, alarm: null });
    this.setState('Running');
    try {
      for (let i = 0; i < lines.length; i++) {
        if (job.stopped) break;
        while (job.paused && !job.stopped) await new Promise((r) => setTimeout(r, 100));
        if (job.stopped) break;
        await this.send(lines[i]);
        if (i % 20 === 0 || i === lines.length - 1) onProgress(i + 1, lines.length);
      }
    } finally {
      this.job = null;
      this.setState(this.port ? 'Connected' : 'Disconnected');
    }
    if (job.alarm) throw new Error(job.alarm);
    return !job.stopped;
  }

  pause() {
    if (!this.job) return;
    this.job.paused = true;
    this.realtime('!');
    this.setState('Paused');
  }

  resume() {
    if (!this.job) return;
    this.job.paused = false;
    this.realtime('~');
    this.setState('Running');
  }

  // Emergency-style stop: soft reset clears GRBL's buffer and turns the laser off.
  async stop() {
    if (this.job) this.job.stopped = true;
    await this.realtime('\x18');
    this.failWaiters('Stopped');
    await new Promise((r) => setTimeout(r, 500));
    this.unlock().catch(() => {});
  }
}
