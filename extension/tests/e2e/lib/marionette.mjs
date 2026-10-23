/**
 * 极简 Marionette 客户端（Firefox 远程协议，geckodriver 用的就是它）。
 *
 * 协议：TCP，`<字节数>:<JSON>` 分帧。命令 `[0, id, "命令名", 参数]`，
 * 响应 `[1, id, 错误?, 结果?]`。用它可以做 Playwright 做不到的事：
 * 临时安装未签名扩展、在 chrome/content 上下文执行脚本、读浏览器日志。
 */
import net from 'node:net';

export class MarionetteError extends Error {
  constructor(name, message, stack) {
    super(`${name}: ${message}`);
    this.name = 'MarionetteError';
    this.remoteName = name;
    this.remoteStack = stack;
  }
}

export class Marionette {
  constructor({ host = '127.0.0.1', port = 2828, timeoutMs = 30000 } = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.handshake = null;
  }

  /** 等 Firefox 的 Marionette 端口起来（启动期间会拒绝连接）。 */
  static async waitForPort({ host = '127.0.0.1', port = 2828, timeoutMs = 30000 } = {}) {
    const start = Date.now();
    for (;;) {
      const ok = await new Promise((resolve) => {
        const sock = net.connect({ host, port });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => { sock.destroy(); resolve(false); });
      });
      if (ok) return true;
      if (Date.now() - start > timeoutMs) throw new Error(`Marionette 端口 ${port} 没起来`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.once('error', reject);
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => {
        for (const { reject: rej } of this.pending.values()) rej(new Error('Marionette 连接已关闭'));
        this.pending.clear();
      });
      // 第一条消息是握手 JSON
      const onHandshake = (line) => {
        try {
          this.handshake = JSON.parse(line);
          if (this.handshake.marionetteProtocol !== 3) {
            throw new Error(`不支持的 Marionette 协议版本 ${this.handshake.marionetteProtocol}`);
          }
          resolve(this.handshake);
        } catch (err) {
          reject(err);
        }
      };
      this._handshakeHandler = onHandshake;
    });
  }

  _onData(chunk) {
    // 帧头是「字节数」，不是字符数：JSON 里有中文时必须按 Buffer 切，否则会错位。
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const idx = this.buffer.indexOf(0x3a); // ':'
      if (idx < 0) return;
      const len = Number(this.buffer.subarray(0, idx).toString('latin1'));
      if (!Number.isFinite(len)) {
        throw new Error(`Marionette 帧头异常：${this.buffer.subarray(0, 40).toString('latin1')}`);
      }
      if (this.buffer.length < idx + 1 + len) return;
      const payload = this.buffer.subarray(idx + 1, idx + 1 + len).toString('utf8');
      this.buffer = this.buffer.subarray(idx + 1 + len);
      if (this._handshakeHandler) {
        const handler = this._handshakeHandler;
        this._handshakeHandler = null;
        handler(payload);
        continue;
      }
      const [kind, id, err, result] = JSON.parse(payload);
      const entry = this.pending.get(id);
      if (!entry) continue;
      this.pending.delete(id);
      if (kind !== 1) {
        entry.reject(new Error(`Marionette 响应帧异常（kind=${kind}, id=${id}）`));
        continue;
      }
      if (err) entry.reject(new MarionetteError(err.error, err.message, err.stacktrace));
      else entry.resolve(result);
    }
  }

  send(name, params = {}) {
    const id = this.nextId++;
    const body = JSON.stringify([0, id, name, params]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Marionette 命令超时：${name}`));
      }, params.timeoutMs || this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.socket.write(`${Buffer.byteLength(body)}:${body}`);
    });
  }

  async newSession(capabilities = {}) {
    return this.send('WebDriver:NewSession', { capabilities: { alwaysMatch: capabilities } });
  }

  /** context: 'content' | 'chrome'。 */
  async setContext(value) {
    return this.send('Marionette:SetContext', { value });
  }

  async navigate(url) {
    return this.send('WebDriver:Navigate', { url });
  }

  /** 在页面（content）或浏览器（chrome）里执行脚本；args 会按 WebDriver 规则序列化。 */
  async executeScript(script, args = []) {
    return this.send('WebDriver:ExecuteScript', { script, args });
  }

  async executeAsyncScript(script, args = [], timeout) {
    return this.send('WebDriver:ExecuteAsyncScript', {
      script, args, ...(timeout ? { scriptTimeout: timeout } : {}),
    });
  }

  /** 临时安装扩展（未签名也能装，重启失效）。path 为 .xpi 文件路径（在 Firefox 所在机器上）。 */
  async installAddon(addonPath, temporary = true) {
    return this.send('Addon:Install', { path: addonPath, temporary });
  }

  async getInstalledAddons() {
    return this.send('Addon:GetInstalledAddons', {});
  }

  async quit() {
    try {
      await this.send('Marionette:Quit', { flags: ['eForceQuit'] });
    } catch {
      /* 进程可能已经退出 */
    }
    try { this.socket.destroy(); } catch { /* ignore */ }
  }
}
