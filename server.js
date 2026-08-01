const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// ===== 用户数据存储 =====
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const usersFile = path.join(dataDir, 'users.json');
const sessionsFile = path.join(dataDir, 'sessions.json');

// 初始化用户数据
if (!fs.existsSync(usersFile)) {
  // 创建超级管理员
  const adminPasswordHash = hashPassword('mrfmrf0513');
  const initialData = {
    users: [
      {
        id: 1,
        username: '没人烦',
        passwordHash: adminPasswordHash,
        status: 'approved',
        role: 'admin',
        createdAt: Date.now()
      }
    ],
    nextUserId: 2
  };
  fs.writeFileSync(usersFile, JSON.stringify(initialData, null, 2));
}

// 初始化会话数据
if (!fs.existsSync(sessionsFile)) {
  fs.writeFileSync(sessionsFile, JSON.stringify({}, null, 2));
}

function loadUsers() {
  return JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
}

function saveUsers(data) {
  fs.writeFileSync(usersFile, JSON.stringify(data, null, 2));
}

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSessions(data) {
  fs.writeFileSync(sessionsFile, JSON.stringify(data, null, 2));
}

// 密码哈希
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

// 生成会话令牌
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 中间件：解析 JSON
app.use(express.json());

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// ===== 认证中间件 =====
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: '未登录' });
  }
  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) {
    return res.status(401).json({ error: '会话已过期' });
  }
  const usersData = loadUsers();
  const user = usersData.users.find(u => u.id === session.userId);
  if (!user) {
    return res.status(401).json({ error: '用户不存在' });
  }
  req.user = user;
  req.token = token;
  next();
}

// ===== 上传配置 =====
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const name = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: Infinity }
});

// ===== API 路由 =====

// 注册
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  if (username.length < 1 || username.length > 20) {
    return res.status(400).json({ error: '用户名长度1-20个字符' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少6位' });
  }

  const usersData = loadUsers();
  const existing = usersData.users.find(u => u.username === username);
  if (existing) {
    return res.status(409).json({ error: '用户名已存在' });
  }

  const newUser = {
    id: usersData.nextUserId++,
    username,
    passwordHash: hashPassword(password),
    status: 'pending',
    role: 'user',
    createdAt: Date.now()
  };
  usersData.users.push(newUser);
  saveUsers(usersData);

  res.json({ success: true, message: '注册成功，请等待管理员审核' });
});

// 登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  const usersData = loadUsers();
  const user = usersData.users.find(u => u.username === username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  if (user.status === 'pending') {
    return res.status(403).json({ error: '账号待审核，请等待管理员通过' });
  }

  if (user.status === 'rejected') {
    return res.status(403).json({ error: '账号已被拒绝，请联系管理员' });
  }

  // 创建会话
  const token = generateToken();
  const sessions = loadSessions();
  sessions[token] = { userId: user.id, createdAt: Date.now() };
  saveSessions(sessions);

  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status
    }
  });
});

// 登出
app.post('/api/logout', authMiddleware, (req, res) => {
  const sessions = loadSessions();
  delete sessions[req.token];
  saveSessions(sessions);
  res.json({ success: true });
});

// 获取当前用户信息
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    role: req.user.role,
    status: req.user.status
  });
});

// 获取待审核用户列表（仅管理员）
app.get('/api/pending-users', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权限' });
  }
  const usersData = loadUsers();
  const pending = usersData.users
    .filter(u => u.status === 'pending')
    .map(u => ({ id: u.id, username: u.username, createdAt: u.createdAt }));
  res.json({ users: pending });
});

// 审核通过用户（仅管理员）
app.post('/api/approve-user', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权限' });
  }
  const { userId } = req.body;
  const usersData = loadUsers();
  const user = usersData.users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  user.status = 'approved';
  saveUsers(usersData);
  res.json({ success: true, message: `已通过 ${user.username} 的审核` });
});

// 拒绝用户（仅管理员）
app.post('/api/reject-user', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权限' });
  }
  const { userId } = req.body;
  const usersData = loadUsers();
  const user = usersData.users.find(u => u.id === userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  user.status = 'rejected';
  saveUsers(usersData);
  res.json({ success: true, message: `已拒绝 ${user.username}` });
});

// 获取所有用户（仅管理员）
app.get('/api/all-users', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权限' });
  }
  const usersData = loadUsers();
  const users = usersData.users.map(u => ({
    id: u.id,
    username: u.username,
    status: u.status,
    role: u.role,
    createdAt: u.createdAt
  }));
  res.json({ users });
});

// 文件上传接口
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到文件' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  // 加密文件 mimetype 不准确，优先使用客户端传入的 mediaType 参数
  const clientMediaType = req.body.mediaType;
  const mediaType = ['image', 'video'].includes(clientMediaType) ? clientMediaType
                  : req.file.mimetype.startsWith('image/') ? 'image'
                  : req.file.mimetype.startsWith('video/') ? 'video'
                  : 'file';
  res.json({ url: fileUrl, mediaType, size: req.file.size });
});

// ===== WebSocket =====
const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 0 });

const clients = new Map();
let clientIdCounter = 0;

// WebSocket 认证：通过 URL 参数传递 token
wss.on('connection', (ws, req) => {
  // 从 URL 解析 token
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, '未认证');
    return;
  }

  const sessions = loadSessions();
  const session = sessions[token];
  if (!session) {
    ws.close(4001, '会话已过期');
    return;
  }

  const usersData = loadUsers();
  const user = usersData.users.find(u => u.id === session.userId);
  if (!user || user.status !== 'approved') {
    ws.close(4003, '账号未通过审核');
    return;
  }

  const clientId = ++clientIdCounter;
  const userInfo = { id: clientId, userId: user.id, name: user.username, publicKey: '', ws };

  clients.set(clientId, userInfo);
  console.log(`用户 ${user.username} 已连接，当前在线: ${clients.size}`);

  ws.send(JSON.stringify({ type: 'assigned-id', id: clientId }));
  broadcastUserList();

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case 'set-name':
        userInfo.publicKey = msg.publicKey || '';
        ws.send(JSON.stringify({ type: 'name-set', name: userInfo.name }));
        broadcastUserList();
        break;

      case 'private-message':
        const targetUser = clients.get(msg.to);
        if (targetUser) {
          targetUser.ws.send(JSON.stringify({
            type: 'private-message',
            from: clientId,
            name: userInfo.name,
            content: msg.content,
            mediaType: msg.mediaType || 'text',
            timestamp: Date.now()
          }));
          ws.send(JSON.stringify({
            type: 'private-message-sent',
            to: msg.to,
            content: msg.content,
            mediaType: msg.mediaType || 'text',
            timestamp: Date.now()
          }));
        }
        break;

      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'webrtc-ice-candidate':
      case 'call-request':
      case 'call-accepted':
      case 'call-rejected':
      case 'call-ended':
        forwardToTarget(msg, ws);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`用户 ${userInfo.name} 已断开，当前在线: ${clients.size}`);
    broadcast({ type: 'user-offline', id: clientId });
    broadcastUserList();
  });
});

function broadcast(message, excludeWs) {
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.ws !== excludeWs && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  });
}

function broadcastUserList() {
  const userList = [];
  clients.forEach((client) => {
    userList.push({ id: client.id, name: client.name || `用户${client.id}`, publicKey: client.publicKey });
  });
  broadcast({ type: 'user-list', users: userList });
}

function forwardToTarget(msg, senderWs) {
  const target = clients.get(msg.to);
  if (target && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(JSON.stringify({
      ...msg,
      from: getClientIdByWs(senderWs)
    }));
  }
}

function getClientIdByWs(ws) {
  for (const [id, info] of clients) {
    if (info.ws === ws) return id;
  }
  return null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 GlassChat 服务器已启动`);
  console.log(`📱 访问地址: http://localhost:${PORT}`);
  console.log(`👑 超级管理员账号: 没人烦`);
  console.log(`\n`);
});
