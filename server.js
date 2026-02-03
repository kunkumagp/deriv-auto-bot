const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3001;
const BOT_STATE_FILE = path.join(__dirname, 'bot_state.json');
const BOT_PROCESS_FILE = path.join(__dirname, 'bot_process.json');
const { spawn } = require('child_process');

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

function readState() {
  try {
    if (!fs.existsSync(BOT_STATE_FILE)) {
      const init = { status: 'paused', waitingUntil: null, waitingTimeLeft: 0 };
      fs.writeFileSync(BOT_STATE_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    return JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf8'));
  } catch (e) {
    return { status: 'paused', waitingUntil: null, waitingTimeLeft: 0 };
  }
}

function writeState(state) {
  try {
    fs.writeFileSync(BOT_STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

app.get('/api/status', (req, res) => {
  res.json(readState());
});

app.post('/api/control', (req, res) => {
  const state = readState();
  const { status } = req.body;
  if (status && (status === 'running' || status === 'paused')) {
    state.status = status;
    const ok = writeState(state);
    return res.json({ ok, state });
  }
  res.status(400).json({ ok: false, error: 'Invalid status' });
});

function readProcessFile() {
  try {
    if (!fs.existsSync(BOT_PROCESS_FILE)) return null;
    return JSON.parse(fs.readFileSync(BOT_PROCESS_FILE, 'utf8'));
  } catch (e) { return null; }
}

function writeProcessFile(obj) {
  try { fs.writeFileSync(BOT_PROCESS_FILE, JSON.stringify(obj, null, 2)); return true; }
  catch (e) { return false; }
}

app.post('/api/launch', (req, res) => {
  const existing = readProcessFile();
  if (existing && existing.pid) {
    try { process.kill(existing.pid, 0); return res.json({ ok: false, error: 'Bot already running', pid: existing.pid }); }
    catch (e) { /* stale pid file, continue to spawn */ }
  }
  // spawn detached process
  const child = spawn(process.execPath, ['over_under_bot.js'], { cwd: __dirname, detached: true, stdio: 'ignore' });
  child.unref();
  writeProcessFile({ pid: child.pid, started: Date.now() });
  // also mark bot state as running so the bot (once started) will actively trade
  const state = readState();
  state.status = 'running';
  writeState(state);
  return res.json({ ok: true, pid: child.pid });
});

app.post('/api/terminate', (req, res) => {
  const info = readProcessFile();
  if (!info || !info.pid) return res.json({ ok: false, error: 'No bot process tracked' });
  try {
    process.kill(info.pid);
    try { fs.unlinkSync(BOT_PROCESS_FILE); } catch(e){}
    // also set bot status to paused
    const state = readState();
    state.status = 'paused';
    writeState(state);
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: false, error: e.message });
  }
});

app.get('/api/process', (req, res) => {
  const info = readProcessFile();
  if (!info || !info.pid) return res.json({ running: false });
  try { process.kill(info.pid, 0); return res.json({ running: true, pid: info.pid, started: info.started }); }
  catch (e) { return res.json({ running: false }); }
});

app.listen(PORT, () => {
  console.log(`Dashboard server running on http://localhost:${PORT}`);
});
