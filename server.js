/**
 * GlassChat 服务器 (server.js)
 * ============================================================================
 * 面对面聊天网站后端 —— 支持文字/图片/视频/语音通话/视频通话
 *
 * 功能模块：
 *   1. 用户认证（注册 / 登录 / 登出，pbkdf2Sync 密码哈希，会话管理）
 *   2. 好友系统（发送 / 接受 / 删除好友，屏蔽 / 取消屏蔽用户）
 *   3. 群组系统（创建 / 加入群组，群组消息中继）
 *   4. 社区频道（发帖 / 评论 / 置顶 / 禁言 / 邀请码）
 *   5. 端到端加密私聊消息中继（WebSocket，服务器无法读取内容）
 *   6. WebRTC 信令中继（语音 / 视频通话，支持 1080p，服务器仅转发）
 *   7. 管理员后台（用户审核 / 封禁 / 删除 / 系统日志 / 强制撤回）
 *   8. 用户个性化设置（主题 / 自定义颜色）
 *
 * 数据存储：JSON 文件（/workspace/data/ 目录下）
 *   - users.json     用户数据
 *   - sessions.json  会话令牌
 *   - groups.json    群组数据
 *   - channels.json  社区频道数据
 * ============================================================================
 */

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// ============================================================================
// 一、数据目录与文件路径
// ============================================================================

const dataDir = path.join(__dirname, 'data');
// 确保数据目录存在
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const usersFile = path.join(dataDir, 'users.json');
const sessionsFile = path.join(dataDir, 'sessions.json');
const groupsFile = path.join(dataDir, 'groups.json');
const channelsFile = path.join(dataDir, 'channels.json');
const transfersFile = path.join(dataDir, 'transfers.json');

// ============================================================================
// 二、密码哈希与令牌生成
// ============================================================================

/**
 * 使用 pbkdf2Sync + 随机盐对密码进行哈希
 * @param {string} password 明文密码
 * @returns {string} "盐:哈希" 格式的字符串
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

/**
 * 验证密码是否匹配
 * @param {string} password 明文密码
 * @param {string} storedHash 存储的 "盐:哈希" 字符串
 * @returns {boolean}
 */
function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

/** 生成随机会话令牌 */
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ============================================================================
// 三、通用 JSON 读写工具
// ============================================================================

/** 读取 JSON 文件，失败时返回兜底值 */
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

/** 将对象写入 JSON 文件（格式化缩进） */
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ============================================================================
// 四、数据加载 / 保存函数
// ============================================================================

function loadUsers() {
  return readJSON(usersFile, { users: [], nextUserId: 1 });
}
function saveUsers(data) {
  writeJSON(usersFile, data);
}

function loadSessions() {
  return readJSON(sessionsFile, {});
}
function saveSessions(data) {
  writeJSON(sessionsFile, data);
}

function loadGroups() {
  return readJSON(groupsFile, { groups: [], nextGroupId: 1 });
}
function saveGroups(data) {
  writeJSON(groupsFile, data);
}

function loadChannels() {
  return readJSON(channelsFile, { channels: [], nextChannelId: 1, nextPostId: 1 });
}
function saveChannels(data) {
  writeJSON(channelsFile, data);
}

// ============================================================================
// 五、初始化数据文件（仅在文件不存在时创建）
// ============================================================================

// 初始化用户数据 —— 内置超级管理员
if (!fs.existsSync(usersFile)) {
  saveUsers({
    users: [
      {
        id: 1,
        username: '没人烦',
        passwordHash: hashPassword('mrfmrf0513'),
        status: 'approved',
        role: 'admin',
        createdAt: Date.now(),
        friends: [],
        blocked: [],
        friendRequests: [],
        settings: { theme: 'green', customColors: {} }
      }
    ],
    nextUserId: 2
  });
}

// 初始化会话数据
if (!fs.existsSync(sessionsFile)) {
  saveSessions({});
}

// 初始化群组数据
if (!fs.existsSync(groupsFile)) {
  saveGroups({ groups: [], nextGroupId: 1 });
}

// 初始化频道数据
if (!fs.existsSync(channelsFile)) {
  saveChannels({ channels: [], nextChannelId: 1, nextPostId: 1 });
}

// ============================================================================
// 六、用户工具函数
// ============================================================================

/**
 * 获取用户的安全副本（带默认值，不含密码哈希）
 * 兼容旧数据：若缺少 friends/blocked/settings 字段则补充默认值
 */
function getSafeUser(user) {
  return {
    id: user.id,
    username: user.username,
    status: user.status,
    role: user.role,
    createdAt: user.createdAt,
    friends: user.friends || [],
    blocked: user.blocked || [],
    friendRequests: user.friendRequests || [],
    settings: user.settings || { theme: 'green', customColors: {} }
  };
}

/** 按 ID 查找用户 */
function findUserById(usersData, userId) {
  return usersData.users.find((u) => u.id === userId);
}

/** 按用户名查找用户 */
function findUserByUsername(usersData, username) {
  return usersData.users.find((u) => u.username === username);
}

// ============================================================================
// 七、系统日志（内存存储，最多保留 500 条）
// ============================================================================

const MAX_LOGS = 500;
const systemLogs = [];

/**
 * 添加一条系统日志
 * @param {string} action 操作描述
 * @param {object} details 详细信息
 */
function addLog(action, details = {}) {
  systemLogs.push({
    id: systemLogs.length + 1,
    action,
    details,
    timestamp: Date.now()
  });
  // 超出上限时丢弃最旧的日志
  if (systemLogs.length > MAX_LOGS) {
    systemLogs.shift();
  }
}

// ============================================================================
// 八、Express 中间件
// ============================================================================

// 解析 JSON 请求体
app.use(express.json());

// 静态文件服务（前端页面）—— dotfiles: 'allow' 确保 .well-known 目录可访问
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

// APK 下载直链
app.get('/GlassChat.apk', (req, res) => {
  const apkPath = path.join(__dirname, 'public', 'GlassChat.apk');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', 'attachment; filename="GlassChat.apk"');
  res.sendFile(apkPath);
});

/**
 * 数字资产链接（TWA 验证）
 * Android TWA APK 通过访问 /.well-known/assetlinks.json 验证网站所有权
 * 验证通过后 APK 内不再显示浏览器地址栏
 */
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(path.join(__dirname, 'public', '.well-known', 'assetlinks.json'));
});

/**
 * 认证中间件 —— 校验 Bearer token
 * 成功后将 user 对象和 token 挂载到 req 上
 */
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
  const user = findUserById(usersData, session.userId);
  if (!user) {
    return res.status(401).json({ error: '用户不存在' });
  }
  // 封禁用户禁止访问
  if (user.status === 'banned') {
    return res.status(403).json({ error: '账号已被封禁' });
  }
  req.user = user;
  req.token = token;
  next();
}

/**
 * 管理员权限中间件 —— 须在 authMiddleware 之后使用
 */
function adminMiddleware(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权限' });
  }
  next();
}

// ============================================================================
// 九、文件上传配置（Multer）
// ============================================================================

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});

// 无大小限制 —— 支持大文件上传（文件内容由客户端端到端加密）
const upload = multer({ storage, limits: { fileSize: Infinity } });

// ============================================================================
// 十、WebSocket 连接管理
// ============================================================================

// 连接映射：connectionId -> { connectionId, userId, username, publicKey, ws }
const clients = new Map();
// 用户连接映射：userId -> Set<connectionId>（支持同一用户多设备同时在线）
const userConnections = new Map();
let connectionIdCounter = 0;

/**
 * 获取某用户的所有在线 WebSocket 连接
 * @param {number} userId 用户 ID
 * @returns {Array} 连接信息数组
 */
function getConnectionsByUserId(userId) {
  const connIds = userConnections.get(userId);
  if (!connIds) return [];
  const conns = [];
  for (const cid of connIds) {
    const c = clients.get(cid);
    if (c && c.ws.readyState === WebSocket.OPEN) {
      conns.push(c);
    }
  }
  return conns;
}

/**
 * 向指定用户的所有连接发送消息
 * @param {number} userId 目标用户 ID
 * @param {object} message 消息对象
 * @returns {boolean} 是否至少送达一个连接
 */
function sendToUser(userId, message) {
  const conns = getConnectionsByUserId(userId);
  if (conns.length === 0) return false;
  const data = JSON.stringify(message);
  for (const c of conns) {
    c.ws.send(data);
  }
  return true;
}

/**
 * 广播消息给所有在线用户
 * @param {object} message 消息对象
 * @param {number|null} excludeUserId 排除的用户 ID
 */
function broadcast(message, excludeUserId = null) {
  const data = JSON.stringify(message);
  clients.forEach((client) => {
    if (client.userId !== excludeUserId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(data);
    }
  });
}

/**
 * 广播在线用户列表（按 userId 去重，同一用户多设备只显示一次）
 * 客户端依赖此列表建立 E2E 加密通道（交换公钥）
 */
function broadcastUserList() {
  const seen = new Set();
  const userList = [];
  clients.forEach((client) => {
    if (!seen.has(client.userId)) {
      seen.add(client.userId);
      userList.push({
        id: client.userId,
        name: client.username,
        publicKey: client.publicKey || ''
      });
    }
  });
  broadcast({ type: 'user-list', users: userList });
}

// ============================================================================
// 十一、API 路由 —— 认证模块
// ============================================================================

/**
 * POST /api/register
 * 注册新用户，状态为 "pending"（待管理员审核）
 */
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
  if (findUserByUsername(usersData, username)) {
    return res.status(409).json({ error: '用户名已存在' });
  }

  const newUser = {
    id: usersData.nextUserId++,
    username,
    passwordHash: hashPassword(password),
    status: 'pending',
    role: 'user',
    createdAt: Date.now(),
    friends: [],
    blocked: [],
    friendRequests: [],
    settings: { theme: 'green', customColors: {} }
  };
  usersData.users.push(newUser);
  saveUsers(usersData);

  addLog('用户注册', { userId: newUser.id, username });
  res.json({ success: true, message: '注册成功，请等待管理员审核' });
});

/**
 * POST /api/login
 * 用户登录，校验状态（pending / rejected / banned 拒绝登录）
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  const usersData = loadUsers();
  const user = findUserByUsername(usersData, username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  // 状态检查
  if (user.status === 'pending') {
    return res.status(403).json({ error: '账号待审核，请等待管理员通过' });
  }
  if (user.status === 'rejected') {
    return res.status(403).json({ error: '账号已被拒绝，请联系管理员' });
  }
  if (user.status === 'banned') {
    return res.status(403).json({ error: '账号已被封禁' });
  }

  // 创建会话
  const token = generateToken();
  const sessions = loadSessions();
  sessions[token] = { userId: user.id, createdAt: Date.now() };
  saveSessions(sessions);

  addLog('用户登录', { userId: user.id, username });
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

/**
 * POST /api/logout
 * 登出，销毁当前会话
 */
app.post('/api/logout', authMiddleware, (req, res) => {
  const sessions = loadSessions();
  delete sessions[req.token];
  saveSessions(sessions);
  addLog('用户登出', { userId: req.user.id, username: req.user.username });
  res.json({ success: true });
});

/**
 * GET /api/me
 * 获取当前用户信息（含好友、屏蔽列表、好友请求、个性化设置）
 */
app.get('/api/me', authMiddleware, (req, res) => {
  res.json(getSafeUser(req.user));
});

// ============================================================================
// 十二、API 路由 —— 好友模块
// ============================================================================

/**
 * POST /api/add-friend
 * 发送好友请求（按用户名查找目标）
 * 将请求者加入目标的 friendRequests 列表，并实时通知目标用户
 */
app.post('/api/add-friend', authMiddleware, (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: '请输入用户名' });
  }

  const usersData = loadUsers();
  const target = findUserByUsername(usersData, username);
  if (!target) {
    return res.status(404).json({ error: '用户不存在' });
  }
  if (target.id === req.user.id) {
    return res.status(400).json({ error: '不能添加自己为好友' });
  }
  if (target.status !== 'approved') {
    return res.status(400).json({ error: '该用户尚未通过审核' });
  }

  // 获取最新的当前用户数据
  const me = findUserById(usersData, req.user.id);
  if (!me) return res.status(404).json({ error: '用户不存在' });

  // 已是好友
  if ((me.friends || []).includes(target.id)) {
    return res.status(400).json({ error: '已经是好友了' });
  }
  // 被对方屏蔽
  if ((target.blocked || []).includes(me.id)) {
    return res.status(403).json({ error: '无法添加该用户' });
  }
  // 已发送过请求
  if ((target.friendRequests || []).includes(me.id)) {
    return res.status(400).json({ error: '已发送过好友请求，请等待对方确认' });
  }

  // 将请求者加入目标的待处理请求列表
  if (!target.friendRequests) target.friendRequests = [];
  target.friendRequests.push(me.id);
  saveUsers(usersData);

  // 实时通知目标用户（WebSocket）
  sendToUser(target.id, {
    type: 'friend-request',
    from: me.id,
    fromName: me.username,
    to: target.id
  });

  addLog('发送好友请求', { from: me.id, fromName: me.username, to: target.id, toName: target.username });
  res.json({ success: true, message: `已向 ${target.username} 发送好友请求` });
});

/**
 * POST /api/accept-friend
 * 接受好友请求（userId 为请求发送者的 ID）
 * 双方互加好友，并实时通知请求发送者
 */
app.post('/api/accept-friend', authMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '缺少用户ID' });
  }

  const usersData = loadUsers();
  const me = findUserById(usersData, req.user.id);
  const requester = findUserById(usersData, userId);
  if (!me || !requester) {
    return res.status(404).json({ error: '用户不存在' });
  }

  // 检查是否存在好友请求
  if (!(me.friendRequests || []).includes(userId)) {
    return res.status(400).json({ error: '没有来自该用户的好友请求' });
  }

  // 从请求列表移除
  me.friendRequests = me.friendRequests.filter((id) => id !== userId);
  // 双方互加好友
  if (!me.friends) me.friends = [];
  if (!me.friends.includes(userId)) me.friends.push(userId);
  if (!requester.friends) requester.friends = [];
  if (!requester.friends.includes(me.id)) requester.friends.push(me.id);
  saveUsers(usersData);

  // 实时通知请求发送者（WebSocket）
  sendToUser(userId, {
    type: 'friend-accepted',
    to: userId,
    userId: me.id,
    username: me.username
  });

  addLog('接受好友请求', { accepter: me.id, accepterName: me.username, requester: userId, requesterName: requester.username });
  res.json({ success: true, message: `已接受 ${requester.username} 的好友请求` });
});

/**
 * POST /api/reject-friend
 * 拒绝好友请求（userId 为请求发送者的 ID）
 * 仅从自己的 friendRequests 列表中移除，不建立好友关系
 */
app.post('/api/reject-friend', authMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '缺少用户ID' });
  }

  const usersData = loadUsers();
  const me = findUserById(usersData, req.user.id);
  if (!me) {
    return res.status(404).json({ error: '用户不存在' });
  }

  // 检查是否存在好友请求
  if (!(me.friendRequests || []).includes(userId)) {
    return res.status(400).json({ error: '没有来自该用户的好友请求' });
  }

  // 从请求列表移除
  me.friendRequests = me.friendRequests.filter((id) => id !== userId);
  saveUsers(usersData);

  addLog('拒绝好友请求', { rejecter: me.id, rejecterName: me.username, requester: userId });
  res.json({ success: true, message: '已拒绝好友请求' });
});

/**
 * POST /api/remove-friend
 * 删除好友（双方互删）
 */
app.post('/api/remove-friend', authMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '缺少用户ID' });
  }

  const usersData = loadUsers();
  const me = findUserById(usersData, req.user.id);
  const friend = findUserById(usersData, userId);
  if (!me) return res.status(404).json({ error: '用户不存在' });

  // 双方互删
  if (me.friends) {
    me.friends = me.friends.filter((id) => id !== userId);
  }
  if (friend && friend.friends) {
    friend.friends = friend.friends.filter((id) => id !== me.id);
  }
  saveUsers(usersData);

  addLog('删除好友', { userId: me.id, username: me.username, removedUserId: userId });
  res.json({ success: true, message: '已删除好友' });
});

/**
 * POST /api/block-user
 * 屏蔽用户（加入屏蔽列表，同时移除好友关系）
 */
app.post('/api/block-user', authMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '缺少用户ID' });
  }
  if (userId === req.user.id) {
    return res.status(400).json({ error: '不能屏蔽自己' });
  }

  const usersData = loadUsers();
  const me = findUserById(usersData, req.user.id);
  if (!me) return res.status(404).json({ error: '用户不存在' });

  if (!me.blocked) me.blocked = [];
  if (!me.blocked.includes(userId)) {
    me.blocked.push(userId);
  }
  // 屏蔽时自动解除好友关系
  if (me.friends) {
    me.friends = me.friends.filter((id) => id !== userId);
  }
  const target = findUserById(usersData, userId);
  if (target && target.friends) {
    target.friends = target.friends.filter((id) => id !== me.id);
  }
  saveUsers(usersData);

  addLog('屏蔽用户', { userId: me.id, username: me.username, blockedUserId: userId });
  res.json({ success: true, message: '已屏蔽该用户' });
});

/**
 * POST /api/unblock-user
 * 取消屏蔽用户
 */
app.post('/api/unblock-user', authMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '缺少用户ID' });
  }

  const usersData = loadUsers();
  const me = findUserById(usersData, req.user.id);
  if (!me) return res.status(404).json({ error: '用户不存在' });

  if (me.blocked) {
    me.blocked = me.blocked.filter((id) => id !== userId);
  }
  saveUsers(usersData);

  addLog('取消屏蔽', { userId: me.id, username: me.username, unblockedUserId: userId });
  res.json({ success: true, message: '已取消屏蔽' });
});

/**
 * GET /api/friends
 * 获取好友列表（含在线状态）
 */
app.get('/api/friends', authMiddleware, (req, res) => {
  const usersData = loadUsers();
  const me = findUserById(usersData, req.user.id);
  if (!me) return res.status(404).json({ error: '用户不存在' });

  const friendIds = me.friends || [];
  const friends = friendIds
    .map((fid) => findUserById(usersData, fid))
    .filter((u) => u && u.status === 'approved')
    .map((u) => ({
      id: u.id,
      username: u.username,
      online: userConnections.has(u.id) // 检查是否有活跃的 WebSocket 连接
    }));

  res.json({ friends });
});

/**
 * GET /api/all-approved-users
 * 获取所有已审核通过的用户（用于添加好友，排除自己）
 */
app.get('/api/all-approved-users', authMiddleware, (req, res) => {
  const usersData = loadUsers();
  const users = usersData.users
    .filter((u) => u.status === 'approved' && u.id !== req.user.id)
    .map((u) => ({ id: u.id, username: u.username }));
  res.json({ users });
});

// ============================================================================
// 十三、API 路由 —— 群组模块
// ============================================================================

/**
 * POST /api/create-group
 * 创建群组（创建者自动加入，同时加入指定的成员）
 */
app.post('/api/create-group', authMiddleware, (req, res) => {
  const { name, memberIds } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '请输入群组名称' });
  }

  const groupsData = loadGroups();
  const usersData = loadUsers();

  // 成员列表：创建者 + 指定成员（去重、验证存在性）
  const members = [req.user.id];
  for (const mid of memberIds || []) {
    if (mid !== req.user.id && !members.includes(mid)) {
      const member = findUserById(usersData, mid);
      if (member && member.status === 'approved') {
        members.push(mid);
      }
    }
  }

  const group = {
    id: groupsData.nextGroupId++,
    name: name.trim(),
    members,
    createdAt: Date.now(),
    createdBy: req.user.id
  };
  groupsData.groups.push(group);
  saveGroups(groupsData);

  addLog('创建群组', { groupId: group.id, name: group.name, createdBy: req.user.id });
  res.json({ success: true, groupId: group.id, message: `群组 "${group.name}" 创建成功` });
});

/**
 * POST /api/join-group
 * 加入群组
 */
app.post('/api/join-group', authMiddleware, (req, res) => {
  const { groupId } = req.body;
  if (!groupId) {
    return res.status(400).json({ error: '缺少群组ID' });
  }

  const groupsData = loadGroups();
  const group = groupsData.groups.find((g) => g.id === groupId);
  if (!group) {
    return res.status(404).json({ error: '群组不存在' });
  }
  if (group.members.includes(req.user.id)) {
    return res.status(400).json({ error: '已在群组中' });
  }

  group.members.push(req.user.id);
  saveGroups(groupsData);

  addLog('加入群组', { groupId, userId: req.user.id, username: req.user.username });
  res.json({ success: true, message: `已加入群组 "${group.name}"` });
});

/**
 * GET /api/groups
 * 获取当前用户加入的所有群组
 */
app.get('/api/groups', authMiddleware, (req, res) => {
  const groupsData = loadGroups();
  const myGroups = groupsData.groups
    .filter((g) => g.members.includes(req.user.id))
    .map((g) => ({
      id: g.id,
      name: g.name,
      members: g.members,
      memberCount: g.members.length,
      createdAt: g.createdAt,
      createdBy: g.createdBy
    }));
  res.json({ groups: myGroups });
});

/**
 * GET /api/group-info?groupId=xxx
 * 获取群组详情（含成员用户名）
 */
app.get('/api/group-info', authMiddleware, (req, res) => {
  const groupId = parseInt(req.query.groupId, 10);
  if (!groupId) {
    return res.status(400).json({ error: '缺少群组ID' });
  }

  const groupsData = loadGroups();
  const group = groupsData.groups.find((g) => g.id === groupId);
  if (!group) {
    return res.status(404).json({ error: '群组不存在' });
  }

  const usersData = loadUsers();
  const members = group.members.map((mid) => {
    const u = findUserById(usersData, mid);
    return u ? { id: u.id, username: u.username, online: userConnections.has(u.id) } : null;
  }).filter(Boolean);

  res.json({
    id: group.id,
    name: group.name,
    members,
    memberCount: group.members.length,
    createdAt: group.createdAt,
    createdBy: group.createdBy
  });
});

// ============================================================================
// 十四、API 路由 —— 消息模块
// ============================================================================

/**
 * POST /api/recall-message
 * 撤回私聊消息（通知对方删除指定时间戳的消息）
 * 由于消息端到端加密且客户端本地存储，服务器仅发送撤回通知
 */
app.post('/api/recall-message', authMiddleware, (req, res) => {
  const { to, timestamp } = req.body;
  if (!to || !timestamp) {
    return res.status(400).json({ error: '缺少参数' });
  }

  // 通过 WebSocket 通知对方撤回消息
  sendToUser(to, {
    type: 'message-recall',
    from: req.user.id,
    to,
    timestamp
  });

  addLog('撤回消息', { userId: req.user.id, to, timestamp });
  res.json({ success: true, message: '已撤回消息' });
});

/**
 * GET /api/message-history?userId=xxx
 * 获取私聊消息历史（端到端加密，客户端本地存储，服务器返回空数组）
 */
app.get('/api/message-history', authMiddleware, (req, res) => {
  res.json({ messages: [] });
});

// ============================================================================
// 十五、API 路由 —— 社区频道模块
// ============================================================================

/**
 * POST /api/create-channel
 * 创建社区频道（自动生成邀请码）
 */
app.post('/api/create-channel', authMiddleware, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '请输入频道名称' });
  }

  const channelsData = loadChannels();
  const channel = {
    id: channelsData.nextChannelId++,
    name: name.trim(),
    description: description || '',
    posts: [],
    muted: [],
    inviteCode: crypto.randomBytes(4).toString('hex'), // 8 位邀请码
    createdAt: Date.now(),
    createdBy: req.user.id
  };
  channelsData.channels.push(channel);
  saveChannels(channelsData);

  addLog('创建频道', { channelId: channel.id, name: channel.name, createdBy: req.user.id });
  res.json({ success: true, channelId: channel.id, inviteCode: channel.inviteCode, message: `频道 "${channel.name}" 创建成功` });
});

/**
 * GET /api/channels
 * 获取所有频道列表（含帖子内容）
 */
app.get('/api/channels', authMiddleware, (req, res) => {
  const channelsData = loadChannels();
  const channels = channelsData.channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    description: ch.description,
    posts: ch.posts || [],
    muted: ch.muted || [],
    inviteCode: ch.inviteCode,
    createdAt: ch.createdAt,
    createdBy: ch.createdBy
  }));
  res.json({ channels });
});

/**
 * POST /api/create-post
 * 在频道中发帖（被禁言用户无法发帖）
 */
app.post('/api/create-post', authMiddleware, (req, res) => {
  const { channelId, content, images } = req.body;
  if (!channelId) {
    return res.status(400).json({ error: '缺少频道ID' });
  }
  if (!content && (!images || images.length === 0)) {
    return res.status(400).json({ error: '内容不能为空' });
  }

  const channelsData = loadChannels();
  const channel = channelsData.channels.find((ch) => ch.id === channelId);
  if (!channel) {
    return res.status(404).json({ error: '频道不存在' });
  }

  // 检查是否被禁言
  if ((channel.muted || []).includes(req.user.id)) {
    return res.status(403).json({ error: '您已被禁言' });
  }

  const post = {
    id: channelsData.nextPostId++,
    authorId: req.user.id,
    authorName: req.user.username,
    content: content || '',
    images: images || [],
    comments: [],
    pinned: false,
    createdAt: Date.now()
  };
  if (!channel.posts) channel.posts = [];
  channel.posts.push(post);
  saveChannels(channelsData);

  res.json({ success: true, post, message: '发帖成功' });
});

/**
 * POST /api/comment-post
 * 评论帖子
 */
app.post('/api/comment-post', authMiddleware, (req, res) => {
  const { channelId, postId, content } = req.body;
  if (!channelId || !postId) {
    return res.status(400).json({ error: '缺少参数' });
  }
  if (!content || !content.trim()) {
    return res.status(400).json({ error: '评论内容不能为空' });
  }

  const channelsData = loadChannels();
  const channel = channelsData.channels.find((ch) => ch.id === channelId);
  if (!channel) {
    return res.status(404).json({ error: '频道不存在' });
  }

  const post = (channel.posts || []).find((p) => p.id === postId);
  if (!post) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  // 检查是否被禁言
  if ((channel.muted || []).includes(req.user.id)) {
    return res.status(403).json({ error: '您已被禁言' });
  }

  const comment = {
    id: Date.now(), // 评论 ID 使用时间戳
    authorId: req.user.id,
    authorName: req.user.username,
    content: content.trim(),
    createdAt: Date.now()
  };
  if (!post.comments) post.comments = [];
  post.comments.push(comment);
  saveChannels(channelsData);

  res.json({ success: true, comment, message: '评论成功' });
});

/**
 * POST /api/pin-post
 * 置顶 / 取消置顶帖子（仅管理员）
 */
app.post('/api/pin-post', authMiddleware, adminMiddleware, (req, res) => {
  const { channelId, postId } = req.body;
  if (!channelId || !postId) {
    return res.status(400).json({ error: '缺少参数' });
  }

  const channelsData = loadChannels();
  const channel = channelsData.channels.find((ch) => ch.id === channelId);
  if (!channel) {
    return res.status(404).json({ error: '频道不存在' });
  }

  const post = (channel.posts || []).find((p) => p.id === postId);
  if (!post) {
    return res.status(404).json({ error: '帖子不存在' });
  }

  post.pinned = !post.pinned; // 切换置顶状态
  saveChannels(channelsData);

  addLog('置顶/取消置顶帖子', { channelId, postId, pinned: post.pinned, admin: req.user.id });
  res.json({ success: true, pinned: post.pinned, message: post.pinned ? '已置顶' : '已取消置顶' });
});

/**
 * POST /api/mute-channel
 * 在频道中禁言用户（仅管理员）
 */
app.post('/api/mute-channel', authMiddleware, adminMiddleware, (req, res) => {
  const { channelId, userId } = req.body;
  if (!channelId || !userId) {
    return res.status(400).json({ error: '缺少参数' });
  }

  const channelsData = loadChannels();
  const channel = channelsData.channels.find((ch) => ch.id === channelId);
  if (!channel) {
    return res.status(404).json({ error: '频道不存在' });
  }

  if (!channel.muted) channel.muted = [];
  if (!channel.muted.includes(userId)) {
    channel.muted.push(userId);
    saveChannels(channelsData);
    addLog('频道禁言', { channelId, userId, admin: req.user.id });
    res.json({ success: true, message: '已禁言该用户' });
  } else {
    // 已在禁言列表中则取消禁言
    channel.muted = channel.muted.filter((id) => id !== userId);
    saveChannels(channelsData);
    addLog('取消频道禁言', { channelId, userId, admin: req.user.id });
    res.json({ success: true, message: '已取消禁言' });
  }
});

/**
 * GET /api/channel-invite?channelId=xxx
 * 获取频道邀请码（不存在则生成）
 */
app.get('/api/channel-invite', authMiddleware, (req, res) => {
  const channelId = parseInt(req.query.channelId, 10);
  if (!channelId) {
    return res.status(400).json({ error: '缺少频道ID' });
  }

  const channelsData = loadChannels();
  const channel = channelsData.channels.find((ch) => ch.id === channelId);
  if (!channel) {
    return res.status(404).json({ error: '频道不存在' });
  }

  // 若无邀请码则生成
  if (!channel.inviteCode) {
    channel.inviteCode = crypto.randomBytes(4).toString('hex');
    saveChannels(channelsData);
  }

  res.json({ inviteCode: channel.inviteCode });
});

// ============================================================================
// 十六、API 路由 —— 管理员模块
// ============================================================================

/**
 * GET /api/pending-users
 * 获取待审核用户列表（仅管理员）
 */
app.get('/api/pending-users', authMiddleware, adminMiddleware, (req, res) => {
  const usersData = loadUsers();
  const pending = usersData.users
    .filter((u) => u.status === 'pending')
    .map((u) => ({ id: u.id, username: u.username, createdAt: u.createdAt }));
  res.json({ users: pending });
});

/**
 * POST /api/approve-user
 * 审核通过用户（仅管理员）
 */
app.post('/api/approve-user', authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.body;
  const usersData = loadUsers();
  const user = findUserById(usersData, userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  user.status = 'approved';
  saveUsers(usersData);

  addLog('审核通过用户', { userId, username: user.username, admin: req.user.id });
  res.json({ success: true, message: `已通过 ${user.username} 的审核` });
});

/**
 * POST /api/reject-user
 * 拒绝用户（仅管理员）
 */
app.post('/api/reject-user', authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.body;
  const usersData = loadUsers();
  const user = findUserById(usersData, userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  user.status = 'rejected';
  saveUsers(usersData);

  // 关闭该用户的所有 WebSocket 连接
  closeUserConnections(userId);

  addLog('拒绝用户', { userId, username: user.username, admin: req.user.id });
  res.json({ success: true, message: `已拒绝 ${user.username}` });
});

/**
 * GET /api/all-users
 * 获取所有用户列表（仅管理员）
 */
app.get('/api/all-users', authMiddleware, adminMiddleware, (req, res) => {
  const usersData = loadUsers();
  const users = usersData.users.map((u) => ({
    id: u.id,
    username: u.username,
    status: u.status,
    role: u.role,
    createdAt: u.createdAt
  }));
  res.json({ users });
});

/**
 * POST /api/ban-user
 * 封禁用户（仅管理员）—— 状态设为 "banned"，并关闭其所有连接
 */
app.post('/api/ban-user', authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '缺少用户ID' });
  }

  const usersData = loadUsers();
  const user = findUserById(usersData, userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  if (user.role === 'admin') {
    return res.status(400).json({ error: '不能封禁管理员' });
  }

  user.status = 'banned';
  saveUsers(usersData);

  // 关闭该用户的所有 WebSocket 连接
  closeUserConnections(userId);

  addLog('封禁用户', { userId, username: user.username, admin: req.user.id });
  res.json({ success: true, message: `已封禁 ${user.username}` });
});

/**
 * POST /api/delete-user
 * 删除用户（仅管理员）—— 从用户列表移除，并清理关联数据
 */
app.post('/api/delete-user', authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: '缺少用户ID' });
  }

  const usersData = loadUsers();
  const user = findUserById(usersData, userId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  if (user.role === 'admin') {
    return res.status(400).json({ error: '不能删除管理员' });
  }

  // 从用户列表中移除
  usersData.users = usersData.users.filter((u) => u.id !== userId);

  // 清理其他用户的好友列表和好友请求
  for (const u of usersData.users) {
    if (u.friends) u.friends = u.friends.filter((id) => id !== userId);
    if (u.blocked) u.blocked = u.blocked.filter((id) => id !== userId);
    if (u.friendRequests) u.friendRequests = u.friendRequests.filter((id) => id !== userId);
  }
  saveUsers(usersData);

  // 清理群组成员
  const groupsData = loadGroups();
  for (const g of groupsData.groups) {
    g.members = g.members.filter((id) => id !== userId);
  }
  saveGroups(groupsData);

  // 清理频道禁言列表
  const channelsData = loadChannels();
  for (const ch of channelsData.channels) {
    if (ch.muted) ch.muted = ch.muted.filter((id) => id !== userId);
  }
  saveChannels(channelsData);

  // 关闭该用户的所有 WebSocket 连接
  closeUserConnections(userId);

  addLog('删除用户', { userId, username: user.username, admin: req.user.id });
  res.json({ success: true, message: `已删除用户 ${user.username}` });
});

/**
 * GET /api/system-logs
 * 获取系统日志（仅管理员，返回最近的日志）
 */
app.get('/api/system-logs', authMiddleware, adminMiddleware, (req, res) => {
  // 返回最近的日志（倒序，最新的在前）
  const recent = [...systemLogs].reverse();
  res.json({ logs: recent });
});

/**
 * POST /api/admin-recall-message
 * 管理员强制撤回消息（通知目标用户删除指定时间戳的消息）
 */
app.post('/api/admin-recall-message', authMiddleware, adminMiddleware, (req, res) => {
  const { targetUserId, timestamp } = req.body;
  if (!targetUserId || !timestamp) {
    return res.status(400).json({ error: '缺少参数' });
  }

  // 通过 WebSocket 通知目标用户撤回消息
  sendToUser(targetUserId, {
    type: 'message-recall',
    from: req.user.id,
    to: targetUserId,
    timestamp,
    adminRecall: true // 标记为管理员强制撤回
  });

  addLog('管理员强制撤回消息', { targetUserId, timestamp, admin: req.user.id });
  res.json({ success: true, message: '已发送撤回指令' });
});

// ============================================================================
// 十七、API 路由 —— 用户设置模块
// ============================================================================

/**
 * POST /api/update-settings
 * 更新用户个性化设置（主题 / 自定义颜色）
 */
app.post('/api/update-settings', authMiddleware, (req, res) => {
  const { theme, customColors } = req.body;

  const usersData = loadUsers();
  const me = findUserById(usersData, req.user.id);
  if (!me) return res.status(404).json({ error: '用户不存在' });

  if (!me.settings) me.settings = { theme: 'green', customColors: {} };
  if (theme) me.settings.theme = theme;
  if (customColors) me.settings.customColors = customColors;
  saveUsers(usersData);

  res.json({ success: true, settings: me.settings, message: '设置已保存' });
});

// ============================================================================
// 十八、文件上传接口
// ============================================================================

/**
 * POST /upload
 * 文件上传（无大小限制）
 * 文件内容由客户端端到端加密，服务器仅存储密文
 * mediaType 由客户端请求体指定（因加密后 mimetype 不准确）
 */
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到文件' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  // 加密文件的 mimetype 不准确，优先使用客户端传入的 mediaType
  const clientMediaType = req.body.mediaType;
  const mediaType = ['image', 'video'].includes(clientMediaType)
    ? clientMediaType
    : req.file.mimetype.startsWith('image/')
      ? 'image'
      : req.file.mimetype.startsWith('video/')
        ? 'video'
        : 'file';
  res.json({ url: fileUrl, mediaType, size: req.file.size });
});

// ============================================================================
// 十八-B、文件传输接口（密码取件）
// ============================================================================

const transferDir = path.join(dataDir, 'transfer_files');
if (!fs.existsSync(transferDir)) {
  fs.mkdirSync(transferDir, { recursive: true });
}

// 文件传输专用 Multer（无大小限制、无类型限制）
const transferStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, transferDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});
const transferUpload = multer({ storage: transferStorage, limits: { fileSize: Infinity } });

// 生成6位字母+数字混合密码（大写）
function generateTransferCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[crypto.randomInt(chars.length)];
    }
  } while (loadTransfers().transfers[code]); // 确保不重复
  return code;
}

// 加载传输记录
function loadTransfers() {
  try {
    return JSON.parse(fs.readFileSync(transfersFile, 'utf8'));
  } catch {
    return { transfers: {} };
  }
}

// 保存传输记录
function saveTransfers(data) {
  fs.writeFileSync(transfersFile, JSON.stringify(data, null, 2));
}

/**
 * POST /api/transfer/upload
 * 上传文件，生成6位取件码
 */
app.post('/api/transfer/upload', authMiddleware, transferUpload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到文件' });
  }

  const code = generateTransferCode();
  const transfersData = loadTransfers();

  transfersData.transfers[code] = {
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadedBy: req.user.id,
    uploadedByName: req.user.username,
    createdAt: Date.now(),
    downloads: 0
  };

  saveTransfers(transfersData);

  res.json({
    success: true,
    code: code,
    filename: req.file.originalname,
    size: req.file.size
  });
});

/**
 * GET /api/transfer/download
 * 通过取件码下载文件（GET方式，支持浏览器直接跳转下载）
 * token 通过 query 参数传递，兼容移动端浏览器
 */
app.get('/api/transfer/download', (req, res) => {
  const code = req.query.code;
  const token = req.query.token;

  // 验证 token
  if (!token) return res.status(401).json({ error: '未登录' });
  const sessionsData = loadSessions();
  const session = sessionsData[token];
  if (!session || session.expires < Date.now()) {
    return res.status(401).json({ error: '登录已过期' });
  }

  if (!code || code.length !== 6) {
    return res.status(400).json({ error: '请输入6位取件码' });
  }

  const transfersData = loadTransfers();
  const transfer = transfersData.transfers[code.toUpperCase()];

  if (!transfer) {
    return res.status(404).json({ error: '取件码无效或文件不存在' });
  }

  const filePath = path.join(transferDir, transfer.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件已被删除' });
  }

  // 增加下载计数
  transfer.downloads = (transfer.downloads || 0) + 1;
  saveTransfers(transfersData);

  // 强制下载，避免浏览器内联显示（APK、视频、文本等）
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(transfer.originalName)}"`);
  res.setHeader('Content-Length', transfer.size);
  res.sendFile(path.resolve(filePath));
});

/**
 * GET /api/transfer/info/:code
 * 通过取件码查询文件信息（不下载）
 */
app.get('/api/transfer/info/:code', authMiddleware, (req, res) => {
  const code = req.params.code;
  if (!code || code.length !== 6) {
    return res.status(400).json({ error: '请输入6位取件码' });
  }

  const transfersData = loadTransfers();
  const transfer = transfersData.transfers[code.toUpperCase()];

  if (!transfer) {
    return res.status(404).json({ error: '取件码无效或文件不存在' });
  }

  const filePath = path.join(transferDir, transfer.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件已被删除' });
  }

  res.json({
    success: true,
    filename: transfer.originalName,
    size: transfer.size,
    mimetype: transfer.mimetype,
    createdAt: transfer.createdAt,
    uploadedByName: transfer.uploadedByName,
    downloads: transfer.downloads || 0
  });
});

// ============================================================================
// 十九、WebSocket 服务器
// ============================================================================

/**
 * 关闭指定用户的所有 WebSocket 连接（用于封禁 / 删除 / 拒绝用户时）
 */
function closeUserConnections(userId) {
  const connIds = userConnections.get(userId);
  if (!connIds) return;
  for (const cid of [...connIds]) {
    const c = clients.get(cid);
    if (c) {
      c.ws.close(4003, '账号状态变更');
    }
  }
}

// 创建 WebSocket 服务器（路径 /ws，无消息大小限制）
const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 0 });

/**
 * WebSocket 连接处理
 * 认证方式：URL 参数 ?token=xxx
 * 消息路由以 userId 为核心（支持同一用户多设备同时在线）
 */
wss.on('connection', (ws, req) => {
  // ---- 1. 认证 ----
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
  const user = findUserById(usersData, session.userId);
  if (!user || user.status !== 'approved') {
    ws.close(4003, '账号未通过审核');
    return;
  }

  // ---- 2. 注册连接 ----
  const connectionId = ++connectionIdCounter;
  const userInfo = {
    connectionId,
    userId: user.id,
    username: user.username,
    publicKey: '',
    ws
  };

  clients.set(connectionId, userInfo);

  // 维护 userId -> 连接集合 映射
  if (!userConnections.has(user.id)) {
    userConnections.set(user.id, new Set());
  }
  userConnections.get(user.id).add(connectionId);

  console.log(`用户 ${user.username} 已连接，当前在线: ${userConnections.size}`);

  // 发送分配的用户 ID（客户端以此为标识进行消息路由）
  ws.send(JSON.stringify({ type: 'assigned-id', id: user.id }));
  broadcastUserList();

  // ---- 3. 消息处理 ----
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return; // 忽略非法 JSON
    }

    switch (msg.type) {
      // ===== 设置公钥（用于端到端加密密钥交换）=====
      case 'set-name':
        userInfo.publicKey = msg.publicKey || '';
        ws.send(JSON.stringify({ type: 'name-set', name: userInfo.username }));
        broadcastUserList();
        break;

      // ===== 私聊消息（端到端加密，服务器仅中继，无法读取内容）=====
      case 'private-message': {
        const targetUserId = msg.to;
        const timestamp = Date.now();
        // 中继给目标用户的所有连接
        sendToUser(targetUserId, {
          type: 'private-message',
          from: userInfo.userId,
          name: userInfo.username,
          content: msg.content,
          mediaType: msg.mediaType || 'text',
          timestamp
        });
        // 向发送者返回确认
        ws.send(JSON.stringify({
          type: 'private-message-sent',
          to: targetUserId,
          content: msg.content,
          mediaType: msg.mediaType || 'text',
          timestamp
        }));
        break;
      }

      // ===== 群组消息（端到端加密，服务器仅中继给指定成员）=====
      // 客户端逐成员加密后发送，to 为目标用户 ID（非群 ID）
      case 'group-message': {
        const targetUserId = msg.to;
        const timestamp = msg.timestamp || Date.now();
        sendToUser(targetUserId, {
          type: 'group-message',
          from: userInfo.userId,
          name: userInfo.username,
          to: targetUserId,
          groupId: msg.groupId,
          groupName: msg.groupName,
          content: msg.content,
          mediaType: msg.mediaType || 'text',
          timestamp,
          ...(msg.fileName ? { fileName: msg.fileName } : {}),
          ...(msg.duration ? { duration: msg.duration } : {})
        });
        break;
      }

      // ===== 群邀请（中继给目标用户）=====
      case 'group-invite':
        sendToUser(msg.to, {
          type: 'group-invite',
          from: userInfo.userId,
          to: msg.to,
          groupId: msg.groupId,
          groupName: msg.groupName,
          members: msg.members,
          inviter: userInfo.userId,
          inviterName: userInfo.username
        });
        break;

      // ===== 消息撤回（中继给目标用户）=====
      case 'message-recall':
        sendToUser(msg.to, {
          type: 'message-recall',
          from: userInfo.userId,
          to: msg.to,
          timestamp: msg.timestamp,
          ...(msg.messageType ? { messageType: msg.messageType } : {}),
          ...(msg.groupId ? { groupId: msg.groupId } : {})
        });
        break;

      // ===== 好友请求通知（中继给目标用户）=====
      case 'friend-request':
        sendToUser(msg.to, {
          type: 'friend-request',
          from: userInfo.userId,
          fromName: userInfo.username,
          to: msg.to
        });
        break;

      // ===== 好友接受通知（中继给目标用户）=====
      case 'friend-accepted':
        sendToUser(msg.to, {
          type: 'friend-accepted',
          from: userInfo.userId,
          fromName: userInfo.username,
          to: msg.to,
          userId: msg.userId || userInfo.userId,
          username: msg.username || userInfo.username
        });
        break;

      // ===== WebRTC 信令中继（语音 / 视频通话，服务器仅转发）=====
      // 支持 1080p —— 服务器不干预质量，由客户端协商编码参数
      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'webrtc-ice-candidate':
      case 'call-request':
      case 'call-accepted':
      case 'call-rejected':
      case 'call-ended':
        // 中继给目标用户，附带发送者信息
        sendToUser(msg.to, {
          ...msg,
          from: userInfo.userId,
          name: userInfo.username
        });
        break;

      default:
        break;
    }
  });

  // ---- 4. 断开连接处理 ----
  ws.on('close', () => {
    clients.delete(connectionId);

    const connSet = userConnections.get(userInfo.userId);
    if (connSet) {
      connSet.delete(connectionId);
      // 该用户所有连接都断开时，通知其他用户该用户已离线
      if (connSet.size === 0) {
        userConnections.delete(userInfo.userId);
        broadcast({ type: 'user-offline', id: userInfo.userId });
      }
    }

    console.log(`用户 ${userInfo.username} 已断开，当前在线: ${userConnections.size}`);
    broadcastUserList();
  });
});

// ============================================================================
// 二十、启动服务器
// ============================================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 GlassChat 服务器已启动`);
  console.log(`📱 访问地址: http://localhost:${PORT}`);
  console.log(`👑 超级管理员账号: 没人烦`);
  console.log(`\n`);
});
