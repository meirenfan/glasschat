/* ============================================================
 * GlassChat 前端逻辑（comprehensive 重写版）
 * 功能：认证 / 主题 / Tab 导航 / 聊天 / 群聊 / 好友 / 社区 /
 *       管理员 / 设置 / 语音消息 / 消息撤回 / WebRTC 1080p 通话
 * 依赖：crypto.js（端到端加密：generateKeyPair, deriveSharedSecret,
 *       encryptText, decryptText, encryptFile, decryptFile,
 *       fetchAndDecryptFile, sharedSecrets, myPublicKeyBase64）
 * 说明：部分 REST/WS 接口需后端配套支持（好友、群聊、社区、撤回等），
 *       前端已按约定调用并做容错；接口缺失时以空状态/Toast 提示。
 * ============================================================ */

// ====================== 全局状态 ======================
let ws = null;                 // WebSocket 连接
let myId = null;               // 当前用户在 WS 中的临时 ID
let myName = '';               // 当前用户名
let myRole = '';               // 当前角色：user / admin
let myDbId = null;             // 当前用户数据库 ID
let authToken = localStorage.getItem('authToken') || null;

// 会话与联系人
let selectedContact = null;    // 当前选中的私聊联系人（onlineUsers 中的一项）
let selectedGroup = null;      // 当前选中的群聊 { id, name, members }
let onlineUsers = [];          // 在线用户列表 [{ id, name, publicKey }]
let conversations = {};        // 私聊消息：{ userId: [message] }
let groupConversations = {};   // 群聊：{ groupId: { id, name, members:[], messages:[] } }
let chatHistoryLoaded = false; // 标记是否已加载本地聊天记录
let friends = [];              // 好友列表
let friendRequests = [];       // 好友请求列表
let blockedUsers = [];         // 屏蔽用户列表
let channels = [];             // 社区频道列表
let selectedChannel = null;    // 当前选中频道

// 未读 / 置顶 / 免打扰
let unreadCounts = {};         // { 'private:5': n, 'group:3': n }
let pinnedConversations = new Set();  // key 集合
let mutedConversations = new Set();   // key 集合

// Tab 与主题
let currentTab = 'chat';
let currentTheme = localStorage.getItem('gc_theme') || 'green';
let customColors = JSON.parse(localStorage.getItem('gc_custom_colors') || 'null') || null;

// 群成员选择缓存、转发缓存
let pendingGroupMembers = [];  // 建群时勾选的成员
let forwardMessageCache = null;// 待转发的消息内容

// 语音消息缓存（blob URL -> 解锁）
let voiceBlobCache = {};

// ====================== WebRTC 状态（保留原有）======================
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let callType = null;            // 'audio' | 'video'
let isCallInitiator = false;
let isInCall = false;
let callTimerInterval = null;
let callStartTime = null;
let iceCandidatesBuffer = [];
let pendingCallFrom = null;
let pendingCallType = null;
let isMuted = false;
let isVideoOff = false;

// WebRTC 配置（保留原有）
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
  ]
};

// 1080p 高清视频约束（保留原有）
const videoConstraints1080p = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  frameRate: { ideal: 30, max: 60 },
  aspectRatio: 1.777777778,
  facingMode: 'user'
};

// RTC 编码器配置 - 1080p 高清（保留原有）
const rtcEncodingConfig = {
  x: {
    maxBitrate: 4_000_000,       // 4 Mbps
    maxFramerate: 30,
    scaleResolutionDownBy: 1,    // 不缩放，保持原始分辨率
  }
};

// 接收偏好 - 优先高清（保留原有）
const rtcReceiverPrefs = [
  { kind: 'video', preference: 'high' },
  { kind: 'audio', preference: 'high' },
];

// 语音录制状态
let mediaRecorder = null;
let recordedChunks = [];
let recordStartTime = 0;
let recordTimerInterval = null;

// ====================== DOM 引用 ======================
const $ = (id) => document.getElementById(id);

// ====================== API 请求工具（保留原有）======================
async function api(path, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const res = await fetch(absUrl(`/api/${path}`), {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// ====================== 工具函数（保留 + 扩展）======================
function showToast(msg, duration = 2500) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.add('hidden'), duration);
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  // 同一天只显示时分
  if (d.toDateString() === now.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // 昨天显示"昨天"
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '昨天';
  // 其他显示月日
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getAvatarColor(name) {
  const colors = [
    'linear-gradient(135deg, #FF6B6B, #FF8E53)',
    'linear-gradient(135deg, #4ECDC4, #44A08D)',
    'linear-gradient(135deg, #667EEA, #764BA2)',
    'linear-gradient(135deg, #F093FB, #F5576C)',
    'linear-gradient(135deg, #4FACFE, #00F2FE)',
    'linear-gradient(135deg, #43E97B, #38F9D7)',
    'linear-gradient(135deg, #FA709A, #FEE140)',
    'linear-gradient(135deg, #30CFD0, #330867)',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function getInitial(name) {
  return name ? name.charAt(0).toUpperCase() : '?';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : text;
  return div.innerHTML;
}

// 生成会话 key（用于未读/置顶/免打扰）
function convKey(type, id) {
  return `${type}:${id}`;
}

// 获取当前选中会话的消息数组与 key
function getCurrentConversation() {
  if (selectedGroup) {
    const g = groupConversations[selectedGroup.id];
    return { type: 'group', id: selectedGroup.id, key: convKey('group', selectedGroup.id), messages: g ? g.messages : [] };
  }
  if (selectedContact) {
    return { type: 'private', id: selectedContact.id, key: convKey('private', selectedContact.id), messages: conversations[selectedContact.id] || [] };
  }
  return null;
}

// ====================== 账号记忆功能 ======================

/** 保存登录凭据到 localStorage（实现账号记忆）*/
function saveCredentials(username, password) {
  localStorage.setItem('gc_saved_user', username);
  localStorage.setItem('gc_saved_pass', password);
}

/** 读取已保存的登录凭据 */
function loadCredentials() {
  const username = localStorage.getItem('gc_saved_user');
  const password = localStorage.getItem('gc_saved_pass');
  if (username && password) return { username, password };
  return null;
}

/** 清除已保存的登录凭据 */
function clearCredentials() {
  localStorage.removeItem('gc_saved_user');
  localStorage.removeItem('gc_saved_pass');
}

/** 使用已保存的凭据自动登录 */
async function autoLogin(username, password) {
  try {
    const data = await api('login', 'POST', { username, password });
    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    myName = data.user.username;
    myRole = data.user.role;
    myDbId = data.user.id;
    enterChat();
    return true;
  } catch (err) {
    clearCredentials();
    return false;
  }
}

// ====================== 聊天记录持久化 ======================

/** 保存聊天记录到 localStorage（实现聊天内容记忆）*/
function saveChatHistory() {
  if (!myName) return;
  try {
    const data = {
      conversations,
      groupConversations,
      savedAt: Date.now(),
    };
    localStorage.setItem(`gc_chat_${myName}`, JSON.stringify(data));
  } catch (err) {
    // localStorage 可能空间不足，静默处理
  }
}

/** 从 localStorage 加载聊天记录 */
function loadChatHistory() {
  if (!myName) return;
  const raw = localStorage.getItem(`gc_chat_${myName}`);
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    // 恢复私聊记录（key 为数据库用户 ID，跨会话稳定）
    if (data.conversations) {
      Object.entries(data.conversations).forEach(([uid, msgs]) => {
        if (!conversations[uid]) conversations[uid] = [];
        msgs.forEach(m => {
          if (!conversations[uid].find(x => x.timestamp === m.timestamp)) {
            conversations[uid].push(m);
          }
        });
      });
    }
    // 恢复群聊记录（群 ID 跨会话稳定）
    if (data.groupConversations) {
      Object.entries(data.groupConversations).forEach(([gid, g]) => {
        if (!groupConversations[gid]) {
          groupConversations[gid] = g;
        } else {
          g.messages.forEach(m => {
            if (!groupConversations[gid].messages.find(x => x.timestamp === m.timestamp)) {
              groupConversations[gid].messages.push(m);
            }
          });
        }
      });
    }
  } catch (err) {
    // JSON 解析失败，静默处理
  }
}

/** 从云端服务器加载消息历史（跨设备同步） */
async function loadCloudMessageHistory() {
  if (!authToken) return;
  try {
    const data = await api('messages/history');
    if (!data.success) return;

    // 合并私聊消息
    if (data.privateMessages) {
      for (const [uidStr, msgs] of Object.entries(data.privateMessages)) {
        const uid = Number(uidStr);
        if (!conversations[uid]) conversations[uid] = [];
        msgs.forEach(m => {
          if (!conversations[uid].find(x => x.timestamp === m.timestamp)) {
            conversations[uid].push(m);
          }
        });
        // 按时间排序
        conversations[uid].sort((a, b) => a.timestamp - b.timestamp);
      }
    }

    // 合并群聊消息
    if (data.groupMessages) {
      for (const [gidStr, msgs] of Object.entries(data.groupMessages)) {
        const gid = Number(gidStr);
        if (!groupConversations[gid]) {
          // 尝试从已有群组信息中获取名称
          let gName = `群${gid}`;
          const existingGroup = Object.values(groupConversations).find(g => g.id === gid);
          if (existingGroup) gName = existingGroup.name;
          groupConversations[gid] = { id: gid, name: gName, members: [], messages: [] };
        }
        msgs.forEach(m => {
          if (!groupConversations[gid].messages.find(x => x.timestamp === m.timestamp)) {
            groupConversations[gid].messages.push(m);
          }
        });
        groupConversations[gid].messages.sort((a, b) => a.timestamp - b.timestamp);
      }
    }

    // 保存到 localStorage
    saveChatHistory();
    renderConversations();
    console.log('云端消息历史加载完成');
  } catch (err) {
    console.error('加载云端消息历史失败:', err);
  }
}

/** 导出用户数据 */
async function exportUserData() {
  var btn = $('exportDataBtn');
  if (btn) { btn.disabled = true; btn.textContent = '正在导出...'; }
  try {
    showToast('正在导出数据...');
    var res = await fetch(absUrl('/api/export-data'), {
      headers: { 'Authorization': 'Bearer ' + authToken }
    });
    if (!res.ok) throw new Error('导出失败');
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var filename = 'glasschat-backup-' + myName + '-' + Date.now() + '.json';

    // 尝试方法1: 创建 <a> 标签下载
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 2000);

    // 方法2: 如果在 Capacitor 中，用 Browser 插件打开数据URL
    try {
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
        var reader = new FileReader();
        reader.onload = function() {
          var dataUrl = reader.result;
          if (dataUrl.length < 2000000) { // 2MB 以下才用 data URL
            window.Capacitor.Plugins.Browser.open({ url: dataUrl }).catch(function(){});
          }
        };
        reader.readAsDataURL(blob);
      }
    } catch (e) {}

    showToast('数据导出成功');
  } catch (err) {
    showToast('导出失败: ' + err.message);
  }
  if (btn) { btn.disabled = false; btn.textContent = '导出我的数据'; }
}

/** 导入用户数据 */
async function importUserData(file) {
  if (!file) return;
  try {
    showToast('正在导入数据...');
    const text = await file.text();
    const importData = JSON.parse(text);
    const res = await fetch(absUrl('/api/import-data'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(importData)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '导入失败');
    showToast('数据导入成功，正在刷新...');
    // 重新加载数据
    loadFriends();
    await loadCloudMessageHistory();
  } catch (err) {
    showToast('导入失败: ' + err.message);
  }
}

// ====================== 认证功能 ======================

// 页面加载时检查登录状态
async function checkSession() {
  if (!authToken) {
    // 没有令牌，尝试用已保存的凭据自动登录
    const creds = loadCredentials();
    if (creds) {
      const ok = await autoLogin(creds.username, creds.password);
      if (ok) return;
    }
    showLoginScreen();
    return;
  }
  try {
    const data = await api('me');
    myName = data.username;
    myRole = data.role;
    myDbId = data.id;
    enterChat();
  } catch (err) {
    // token 过期或无效，尝试自动重新登录
    localStorage.removeItem('authToken');
    authToken = null;
    const creds = loadCredentials();
    if (creds) {
      const ok = await autoLogin(creds.username, creds.password);
      if (ok) return;
    }
    showLoginScreen();
  }
}

// 显示登录界面
function showLoginScreen() {
  $('loginScreen').classList.remove('hidden');
  $('chatScreen').classList.add('hidden');
  $('adminScreen').classList.add('hidden');
  showLoginForm();
}

// 显示聊天界面
function enterChat() {
  $('loginScreen').classList.add('hidden');
  $('adminScreen').classList.add('hidden');
  $('chatScreen').classList.remove('hidden');

  // 头像与昵称
  $('myName').textContent = myName;
  $('myAvatar').textContent = getInitial(myName);
  $('myAvatar').style.background = getAvatarColor(myName);
  $('navAvatar').textContent = getInitial(myName);
  $('navAvatar').style.background = getAvatarColor(myName);

  // 设置页账户信息
  $('accountUsername').textContent = myName;
  $('accountRole').textContent = myRole === 'admin' ? '管理员' : '普通用户';
  $('accountId').textContent = myDbId != null ? myDbId : '—';
  $('settingsAdminBtn').style.display = myRole === 'admin' ? 'block' : 'none';

  // 应用主题
  loadTheme();

  // 连接 WebSocket
  connectWebSocket();

  // 默认进入聊天 Tab
  switchTab('chat');
  resetChatSelection();

  // 加载好友 / 社区（容错：接口缺失则静默）
  loadFriends();
  loadChannels();
  // 从云端加载聊天记录（跨设备同步）
  loadCloudMessageHistory();
}

// 切换到登录表单
function showLoginForm() {
  $('loginForm').classList.remove('hidden');
  $('registerForm').classList.add('hidden');
  $('adminLoginForm').classList.add('hidden');
}

// 切换到注册表单
function showRegisterForm() {
  $('loginForm').classList.add('hidden');
  $('registerForm').classList.remove('hidden');
  $('adminLoginForm').classList.add('hidden');
}

// 切换到管理员登录表单（隐藏入口）
function showAdminLoginForm() {
  $('loginForm').classList.add('hidden');
  $('registerForm').classList.add('hidden');
  $('adminLoginForm').classList.remove('hidden');
}

// 登录
async function handleLogin() {
  const username = $('loginUsername').value.trim();
  const password = $('loginPassword').value;

  if (!username || !password) {
    showToast('请输入用户名和密码');
    return;
  }

  $('loginBtn').disabled = true;
  $('loginBtn').textContent = '登录中...';

  try {
    const data = await api('login', 'POST', { username, password });
    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    myName = data.user.username;
    myRole = data.user.role;
    myDbId = data.user.id;
    saveCredentials(username, password); // 保存凭据，实现账号记忆
    showToast('登录成功');
    enterChat();
  } catch (err) {
    showToast(err.message);
  } finally {
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = '登录';
  }
}

// 管理员登录（复用 /api/login）
async function handleAdminLogin() {
  const username = $('adminLoginUsername').value.trim();
  const password = $('adminLoginPassword').value;
  if (!username || !password) {
    showToast('请输入管理员账号和密码');
    return;
  }
  $('adminLoginBtn').disabled = true;
  $('adminLoginBtn').textContent = '登录中...';
  try {
    const data = await api('login', 'POST', { username, password });
    if (data.user.role !== 'admin') {
      showToast('该账号不是管理员');
      return;
    }
    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    myName = data.user.username;
    myRole = data.user.role;
    myDbId = data.user.id;
    saveCredentials(username, password); // 保存凭据，实现账号记忆
    showToast('管理员登录成功');
    enterChat();
    showAdminPanel();
  } catch (err) {
    showToast(err.message);
  } finally {
    $('adminLoginBtn').disabled = false;
    $('adminLoginBtn').textContent = '管理员登录';
  }
}

// 注册
async function handleRegister() {
  const username = $('registerUsername').value.trim();
  const password = $('registerPassword').value;
  const confirm = $('registerPasswordConfirm').value;

  if (!username || !password) {
    showToast('请输入用户名和密码');
    return;
  }
  if (password.length < 6) {
    showToast('密码至少6位');
    return;
  }
  if (password !== confirm) {
    showToast('两次密码不一致');
    return;
  }

  $('registerBtn').disabled = true;
  $('registerBtn').textContent = '注册中...';

  try {
    await api('register', 'POST', { username, password });
    showToast('注册成功，请等待管理员审核');
    // 清空注册表单，切回登录
    $('registerUsername').value = '';
    $('registerPassword').value = '';
    $('registerPasswordConfirm').value = '';
    $('loginUsername').value = username;
    showLoginForm();
  } catch (err) {
    showToast(err.message);
  } finally {
    $('registerBtn').disabled = false;
    $('registerBtn').textContent = '注册';
  }
}

// 退出登录
async function handleLogout() {
  try {
    await api('logout', 'POST');
  } catch {}
  localStorage.removeItem('authToken');
  authToken = null;
  myName = '';
  myRole = '';
  myDbId = null;
  if (ws) { ws.close(); ws = null; }
  // 清空状态（保留已保存凭据和聊天记录，实现账号记忆和聊天记忆）
  selectedContact = null;
  selectedGroup = null;
  onlineUsers = [];
  conversations = {};
  groupConversations = {};
  friends = [];
  friendRequests = [];
  blockedUsers = [];
  channels = [];
  selectedChannel = null;
  unreadCounts = {};
  pinnedConversations.clear();
  mutedConversations.clear();
  chatHistoryLoaded = false;
  showLoginScreen();
}

// 切换账号：清除凭据和聊天记录，显示登录界面
function handleSwitchAccount() {
  clearCredentials();
  clearKeyPair(); // 清除加密密钥对
  if (myName) localStorage.removeItem(`gc_chat_${myName}`);
  handleLogout();
  showToast('已清除账号记忆，请重新登录');
}

// 清除聊天记录
function handleClearChat() {
  if (myName) {
    localStorage.removeItem(`gc_chat_${myName}`);
    conversations = {};
    groupConversations = {};
    renderMessages();
    renderConversations();
    showToast('聊天记录已清除');
  }
}

// ====================== 检查更新 ======================
const APP_VERSION = '1.3';
const APP_VERSION_CODE = 4;

/**
 * 下载更新 —— 多重回退策略，确保在 Capacitor WebView 中也能打开下载链接
 * 方法1: Capacitor Browser 插件（如果已安装）
 * 方法2: 创建临时 <a> 标签并模拟点击（WebView 内下载）
 * 方法3: window.open 在新窗口打开
 * 方法4: 直接修改 location.href 跳转
 */
function downloadUpdate(url) {
  console.log('[Update] 尝试下载:', url);

  // 方法1: Capacitor Browser 插件
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
      window.Capacitor.Plugins.Browser.open({ url })
        .then(() => { console.log('[Update] Browser 插件打开成功'); })
        .catch(function(err) {
          console.warn('[Update] Browser 插件失败，尝试回退:', err);
          fallbackDownload(url);
        });
      return;
    }
  } catch (e) {
    console.warn('[Update] Browser 插件异常:', e);
  }

  fallbackDownload(url);
}

/** 回退下载方法 */
function fallbackDownload(url) {
  // 方法2: 创建临时 <a> 标签模拟点击
  try {
    var a = document.createElement('a');
    a.href = url;
    a.download = 'GlassChat.apk';
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); }, 1000);
    console.log('[Update] <a> 标签点击已触发');
    return;
  } catch (e) {
    console.warn('[Update] <a> 标签失败:', e);
  }

  // 方法3: window.open
  try {
    var win = window.open(url, '_blank');
    if (win) {
      console.log('[Update] window.open 成功');
      return;
    }
  } catch (e) {
    console.warn('[Update] window.open 失败:', e);
  }

  // 方法4: 直接跳转
  console.log('[Update] 使用 location.href 跳转');
  window.location.href = url;
}

// 确保函数在全局作用域可访问（inline onclick 需要）
window.downloadUpdate = downloadUpdate;
window.sendFriendRequestById = sendFriendRequestById;
window.chatWithOnlineUser = chatWithOnlineUser;

async function checkForUpdates() {
  var btn = $('checkUpdateBtn');
  var result = $('updateResult');
  if (!btn || !result) return;

  btn.disabled = true;
  btn.textContent = '正在检查更新...';
  result.classList.remove('hidden');
  result.style.background = 'rgba(116,198,157,0.15)';
  result.style.color = 'var(--text-primary)';
  result.textContent = '正在连接服务器检查版本...';

  try {
    var url = absUrl('/api/version');
    var res = await fetch(url);
    if (!res.ok) throw new Error('服务器响应异常');
    var data = await res.json();

    var serverVersionCode = data.versionCode || 1;
    var serverVersion = data.version || '1.0';

    if (serverVersionCode > APP_VERSION_CODE) {
      var downloadUrl = absUrl(data.downloadUrl);
      result.style.background = 'rgba(255,159,10,0.15)';
      result.innerHTML =
        '<div style="font-weight:600;margin-bottom:8px;">发现新版本 v' + serverVersion + '</div>' +
        '<div style="margin-bottom:12px;">' + (data.updateInfo || '有新版本可用') + '</div>' +
        '<a id="downloadUpdateBtn" href="' + downloadUrl + '" download="GlassChat.apk" ' +
        'style="display:inline-block;padding:12px 28px;background:var(--btn-highlight);color:#fff;' +
        'border:none;border-radius:14px;font-weight:600;font-size:17px;cursor:pointer;' +
        'text-decoration:none;position:relative;z-index:999;touch-action:manipulation;' +
        '-webkit-tap-highlight-color:transparent;user-select:none;">立即下载更新</a>' +
        '<div style="margin-top:10px;font-size:12px;color:var(--text-tertiary);">' +
        '点击按钮开始下载，下载完成后点击安装</div>' +
        '<div style="margin-top:6px;font-size:12px;color:var(--text-tertiary);">' +
        '如无法下载，请用手机浏览器访问：<br>' + downloadUrl + '</div>';

      // 用 addEventListener 绑定点击事件（比 inline onclick 更可靠）
      var dlBtn = $('downloadUpdateBtn');
      if (dlBtn) {
        dlBtn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          downloadUpdate(downloadUrl);
          return false;
        }, { passive: false });
      }
    } else {
      result.style.background = 'rgba(48,209,88,0.15)';
      result.innerHTML = '<div style="font-weight:600;">当前已是最新版本 v' + APP_VERSION + '</div>' +
        '<div style="margin-top:4px;font-size:12px;opacity:0.7;">服务器版本: v' + serverVersion + '</div>';
    }
  } catch (err) {
    result.style.background = 'rgba(255,69,58,0.15)';
    result.style.color = '#FF453A';
    result.textContent = '检查更新失败: ' + (err.message || '网络错误') + '\n请确认网络连接正常后重试。';
  }

  btn.disabled = false;
  btn.textContent = '检查更新';
}

// ====================== 主题系统 ======================

// 加载主题与自定义颜色
function loadTheme() {
  // 优先从用户设置接口读取（容错）
  applyTheme(currentTheme);
  if (customColors) applyCustomColors(customColors);
  syncThemeUI();
  syncColorUI();
}

// 应用主题：设置 body class
function applyTheme(theme) {
  currentTheme = theme;
  document.body.classList.remove('theme-green', 'theme-white', 'theme-dark');
  document.body.classList.add(`theme-${theme}`);
  localStorage.setItem('gc_theme', theme);
}

// 应用自定义颜色：设置 :root CSS 变量
function applyCustomColors(colors) {
  customColors = colors;
  const root = document.documentElement;
  // 使用 removeProperty 清除变量，确保 var() 能正确回退到主题默认色
  // （setProperty 设为空字符串会被视为有效值，导致回退失效）
  if (colors.bubble) root.style.setProperty('--custom-bubble', colors.bubble);
  else root.style.removeProperty('--custom-bubble');
  if (colors.sidebar) {
    // 侧边栏使用带透明度的颜色
    root.style.setProperty('--custom-sidebar', hexToRgba(colors.sidebar, 0.7));
  } else {
    root.style.removeProperty('--custom-sidebar');
  }
  if (colors.button) root.style.setProperty('--custom-button', colors.button);
  else root.style.removeProperty('--custom-button');
  localStorage.setItem('gc_custom_colors', JSON.stringify(colors));
}

// hex 转 rgba
function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// 同步主题卡片选中状态
function syncThemeUI() {
  document.querySelectorAll('.theme-card').forEach(card => {
    card.classList.toggle('selected', card.dataset.theme === currentTheme);
  });
}

// 同步颜色选择器 UI
function syncColorUI() {
  if (!customColors) return;
  if (customColors.bubble) {
    $('colorBubble').value = customColors.bubble;
    $('colorBubbleHex').value = customColors.bubble;
  }
  if (customColors.sidebar) {
    $('colorSidebar').value = customColors.sidebar;
    $('colorSidebarHex').value = customColors.sidebar;
  }
  if (customColors.button) {
    $('colorButton').value = customColors.button;
    $('colorButtonHex').value = customColors.button;
  }
}

// 切换主题（应用 + 保存）
async function switchTheme(theme) {
  applyTheme(theme);
  syncThemeUI();
  await saveSettings();
}

// 实时更新单个自定义颜色（预览）
function updateCustomColor(type, color) {
  if (!customColors) customColors = {};
  customColors[type] = color;
  applyCustomColors(customColors);
}

// 保存自定义颜色
async function saveCustomColors() {
  if (!customColors) {
    customColors = {
      bubble: $('colorBubbleHex').value,
      sidebar: $('colorSidebarHex').value,
      button: $('colorButtonHex').value,
    };
  }
  applyCustomColors(customColors);
  await saveSettings();
  showToast('自定义颜色已保存');
}

// 各主题默认色值
const themeDefaultColors = {
  green:  { bubble: '#E6F4EA', sidebar: '#D4EDDA', button: '#74C69D' },
  white:  { bubble: '#F8F9FA', sidebar: '#F8F9FA', button: '#007AFF' },
  dark:   { bubble: '#1E2128', sidebar: '#1E2128', button: '#0A84FF' },
};

// 重置为当前主题的默认配色
async function resetCustomColors() {
  const defaults = themeDefaultColors[currentTheme] || themeDefaultColors.green;
  customColors = { bubble: '', sidebar: '', button: '' };
  // 清除 :root 上的自定义变量，回退到主题默认
  const root = document.documentElement;
  root.style.removeProperty('--custom-bubble');
  root.style.removeProperty('--custom-sidebar');
  root.style.removeProperty('--custom-button');
  localStorage.removeItem('gc_custom_colors');
  // 同步颜色选择器 UI 为默认值
  $('colorBubble').value = defaults.bubble;
  $('colorBubbleHex').value = defaults.bubble;
  $('colorSidebar').value = defaults.sidebar;
  $('colorSidebarHex').value = defaults.sidebar;
  $('colorButton').value = defaults.button;
  $('colorButtonHex').value = defaults.button;
  await saveSettings();
  showToast('已重置为默认配色');
}

// 保存用户设置到后端（容错：接口缺失则仅本地保存）
async function saveSettings() {
  try {
    await api('update-settings', 'POST', {
      theme: currentTheme,
      customColors: customColors || {},
      pinned: Array.from(pinnedConversations),
      muted: Array.from(mutedConversations),
    });
  } catch (err) {
    // 接口未实现时静默，已写入 localStorage
  }
}

// ====================== Tab 导航 ======================

// 切换 Tab：显示/隐藏对应内容，更新激活态
function switchTab(tabName) {
  currentTab = tabName;
  // 内容区
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  const tab = $(`tab-${tabName}`);
  if (tab) tab.classList.add('active');

  // 桌面端左侧导航
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tabName);
  });
  // 移动端底部标签栏
  document.querySelectorAll('.bottom-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tabName);
  });

  // 进入各 Tab 时刷新对应数据
  if (tabName === 'contacts') {
    loadFriends();
  } else if (tabName === 'community') {
    loadChannels();
    if (selectedChannel) {
      document.querySelector('.community-page')?.classList.add('show-detail');
      renderChannelDetail();
    }
  } else if (tabName === 'settings') {
    syncThemeUI();
    syncColorUI();
  } else if (tabName === 'chat') {
    renderConversations();
  }
}

// ====================== WebSocket 连接（增强）======================
async function connectWebSocket() {
  // 使用 SERVER_URL 构建 WebSocket 地址（Capacitor 环境不能用 location.host）
  const wsUrl = absUrl(`/ws?token=${authToken}`).replace(/^https/, 'wss').replace(/^http/, 'ws');
  ws = new WebSocket(wsUrl);

  ws.onopen = async () => {
    console.log('WebSocket 已连接');
    // 生成密钥对
    await generateKeyPair();
    ws.send(JSON.stringify({ type: 'set-name', name: myName, publicKey: myPublicKeyBase64 }));
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    console.log('WebSocket 断开');
    // 仅在已认证时自动重连
    if (authToken) {
      console.log('3秒后重连...');
      setTimeout(connectWebSocket, 3000);
    }
  };

  ws.onerror = (err) => console.error('WebSocket 错误:', err);
}

function sendWS(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ====================== 消息处理（增强：新消息类型）======================
async function handleMessage(msg) {
  switch (msg.type) {
    case 'assigned-id':
      myId = msg.id;
      break;

    case 'name-set':
      $('myName').textContent = msg.name;
      $('myAvatar').textContent = getInitial(msg.name);
      $('myAvatar').style.background = getAvatarColor(msg.name);
      $('navAvatar').textContent = getInitial(msg.name);
      $('navAvatar').style.background = getAvatarColor(msg.name);
      break;

    case 'user-list':
      onlineUsers = msg.users.filter(u => u.id !== myId);
      // 首次收到用户列表时加载本地聊天记录
      if (!chatHistoryLoaded) {
        loadChatHistory();
        chatHistoryLoaded = true;
      }
      // 为每个在线用户派生共享密钥
      for (const user of onlineUsers) {
        if (user.publicKey && !sharedSecrets[user.id]) {
          try {
            await deriveSharedSecret(user.publicKey, user.id);
            console.log(`已与用户 ${user.name} 建立加密通道`);
          } catch (err) {
            console.error('派生共享密钥失败:', err);
          }
        }
      }
      renderConversations();
      renderFriendsList();
      break;

    case 'user-offline':
      // 移除在线状态
      if (selectedContact && selectedContact.id === msg.id) {
        $('chatPartnerStatus').textContent = '离线';
      }
      if (isInCall && pendingCallFrom === msg.id) {
        endCall();
      }
      renderConversations();
      break;

    case 'user-status-update':
      // 用户上下线状态更新（兼容 user-list 之外的细粒度通知）
      renderConversations();
      renderFriendsList();
      break;

    case 'private-message':
      await receiveMessage(msg.from, msg.name, msg.content, msg.mediaType, msg.timestamp);
      break;

    case 'private-message-sent':
      // 确认消息已发送（可标记为已送达）
      break;

    // ===== 群聊消息 =====
    case 'group-message':
      await receiveGroupMessage(msg);
      break;

    // ===== 群邀请 =====
    case 'group-invite':
      handleGroupInvite(msg);
      break;

    // ===== 消息撤回 =====
    case 'message-recall':
      handleRecall(msg);
      break;

    // ===== 好友系统 =====
    case 'friend-request':
      showToast(`${msg.fromName || '有人'} 请求添加你为好友`);
      loadFriends();
      break;

    case 'friend-accepted':
      showToast(`${msg.fromName || '对方'} 已接受你的好友请求`);
      loadFriends();
      break;

    // ===== 通话（保留原有）=====
    case 'call-request':
      handleIncomingCall(msg);
      break;
    case 'call-accepted':
      handleCallAccepted(msg);
      break;
    case 'call-rejected':
      handleCallRejected();
      break;
    case 'call-ended':
      handleCallEnded();
      break;

    // ===== WebRTC（保留原有）=====
    case 'webrtc-offer':
      handleWebRTCOffer(msg);
      break;
    case 'webrtc-answer':
      handleWebRTCAnswer(msg);
      break;
    case 'webrtc-ice-candidate':
      handleICECandidate(msg);
      break;

    default:
      break;
  }
}

// ====================== 会话列表渲染（私聊 + 群聊，置顶优先）======================
function renderConversations() {
  const list = $('conversationList');
  if (!list) return;
  const search = ($('searchInput')?.value || '').toLowerCase();

  // 收集所有会话项
  const items = [];

  // 私聊会话（有消息记录 或 在线好友）
  const privateIds = new Set([
    ...Object.keys(conversations).map(Number),
    ...friends.filter(f => isUserOnline(f.id)).map(f => f.id),
    ...onlineUsers.map(u => u.id),
  ]);

  privateIds.forEach(uid => {
    const msgs = conversations[uid] || [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const user = onlineUsers.find(u => u.id === uid);
    const friend = friends.find(f => f.id === uid);
    // 优先使用在线用户名/好友名，其次从聊天记录中提取对方名称
    const name = user?.name || friend?.username
      || (last && last.name !== myName ? last.name : `用户${uid}`);
    const online = isUserOnline(uid);
    items.push({
      type: 'private',
      id: uid,
      name,
      last,
      online,
      key: convKey('private', uid),
    });
  });

  // 群聊会话
  Object.values(groupConversations).forEach(g => {
    const last = g.messages.length ? g.messages[g.messages.length - 1] : null;
    items.push({
      type: 'group',
      id: g.id,
      name: g.name,
      last,
      online: true,
      key: convKey('group', g.id),
    });
  });

  // 关键字过滤
  let filtered = items.filter(it => it.name.toLowerCase().includes(search));

  // 排序：置顶在前，再按最后消息时间倒序；无消息的排最后
  filtered.sort((a, b) => {
    const pa = pinnedConversations.has(a.key) ? 1 : 0;
    const pb = pinnedConversations.has(b.key) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    const ta = a.last ? a.last.timestamp : 0;
    const tb = b.last ? b.last.timestamp : 0;
    return tb - ta;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-contacts">暂无会话，去通讯录添加好友开始聊天</div>';
    return;
  }

  list.innerHTML = filtered.map(it => {
    const isActive = (it.type === 'private' && selectedContact && selectedContact.id === it.id)
                  || (it.type === 'group' && selectedGroup && selectedGroup.id === it.id);
    const unread = unreadCounts[it.key] || 0;
    const muted = mutedConversations.has(it.key);
    const pinned = pinnedConversations.has(it.key);
    const lastPreview = it.last ? previewMessage(it.last) : (it.type === 'group' ? '群聊已创建' : '点击开始聊天');
    const lastTime = it.last ? formatTime(it.last.timestamp) : '';
    const avatarClass = it.type === 'group' ? 'conv-avatar group' : 'conv-avatar';
    const onlineDot = (it.type === 'private' && it.online) ? '<span class="conv-online"></span>' : '';

    return `
      <div class="conversation-item ${isActive ? 'active' : ''}" onclick="selectConversation('${it.type}', ${it.id})">
        <div class="${avatarClass}" style="background:${getAvatarColor(it.name)}">${getInitial(it.name)}${onlineDot}</div>
        <div class="conv-info">
          <div class="conv-top">
            <span class="conv-name">${escapeHtml(it.name)}</span>
            <span class="conv-time">${lastTime}</span>
          </div>
          <div class="conv-bottom">
            <span class="conv-last">${escapeHtml(lastPreview)}</span>
            <span class="conv-badges">
              ${muted ? '<span class="conv-icon" title="已免打扰"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg></span>' : ''}
              ${pinned ? '<span class="conv-icon" title="已置顶"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-3V8a3 3 0 0 0-3-3h-5a3 3 0 0 0-3 3v6z"/></svg></span>' : ''}
              ${unread > 0 ? `<span class="conv-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
            </span>
          </div>
        </div>
      </div>`;
  }).join('');
}

// 判断用户是否在线（按 WS id）
function isUserOnline(uid) {
  return onlineUsers.some(u => u.id === uid);
}

// 生成消息预览文本
function previewMessage(m) {
  if (m.recalled) return '[消息已撤回]';
  if (m.mediaType === 'image') return '[图片]';
  if (m.mediaType === 'video') return '[视频]';
  if (m.mediaType === 'audio') return '[语音]';
  if (m.mediaType === 'file') return '[文件]';
  const prefix = m.from === myId ? '我: ' : '';
  return prefix + (m.content || '');
}

// 统一会话选择入口（供 onclick 调用）
function selectConversation(type, id) {
  if (type === 'group') selectGroup(id);
  else selectContact(id);
}

// ====================== 聊天：选择联系人 / 群 ======================
function selectContact(userId) {
  const user = onlineUsers.find(u => u.id === userId)
            || (friends.find(f => f.id === userId) ? { id: userId, name: friends.find(f => f.id === userId).username } : null);
  if (!user) {
    // 如果有聊天记录，允许查看历史消息（用户离线时）
    const hist = conversations[userId];
    if (hist && hist.length > 0) {
      const lastMsg = hist[hist.length - 1];
      selectedContact = { id: userId, name: lastMsg.name === myName ? `用户${userId}` : lastMsg.name };
      selectedGroup = null;
      $('chatPartnerName').textContent = selectedContact.name;
      $('chatPartnerStatus').textContent = '离线';
      $('chatPartnerAvatar').textContent = getInitial(selectedContact.name);
      $('chatPartnerAvatar').style.background = getAvatarColor(selectedContact.name);
      // 禁用输入（对方离线）
      $('messageInput').disabled = true;
      $('sendBtn').disabled = true;
      $('voiceRecordBtn').disabled = true;
      $('emojiBtn').disabled = true;
      $('imageBtn').disabled = true;
      $('videoSendBtn').disabled = true;
      $('fileBtn').disabled = true;
      unreadCounts[convKey('private', userId)] = 0;
      renderMessages();
      renderConversations();
      showChatOnMobile();
      return;
    }
    showToast('该用户不在线或不是好友');
    return;
  }

  selectedContact = user;
  selectedGroup = null;

  $('chatPartnerName').textContent = user.name;
  $('chatPartnerStatus').textContent = isUserOnline(userId) ? '在线' : '离线';
  $('chatPartnerAvatar').textContent = getInitial(user.name);
  $('chatPartnerAvatar').style.background = getAvatarColor(user.name);

  enableInput();
  // 清除未读
  unreadCounts[convKey('private', userId)] = 0;

  renderMessages();
  renderConversations();
  showChatOnMobile();
}

function selectGroup(groupId) {
  const g = groupConversations[groupId];
  if (!g) {
    showToast('群聊不存在');
    return;
  }
  selectedGroup = g;
  selectedContact = null;

  $('chatPartnerName').textContent = g.name;
  $('chatPartnerStatus').textContent = `群聊 · ${g.members.length} 人`;
  $('chatPartnerAvatar').textContent = getInitial(g.name);
  $('chatPartnerAvatar').style.background = getAvatarColor(g.name);

  enableInput();
  // 群聊不支持语音/视频通话（仅私聊）
  $('voiceCallBtn').disabled = true;
  $('videoCallBtn').disabled = true;

  unreadCounts[convKey('group', groupId)] = 0;
  renderMessages();
  renderConversations();
  showChatOnMobile();
}

function enableInput() {
  $('messageInput').disabled = false;
  $('sendBtn').disabled = false;
  $('imageBtn').disabled = false;
  $('videoSendBtn').disabled = false;
  $('fileBtn').disabled = false;
  $('emojiBtn').disabled = false;
  $('voiceRecordBtn').disabled = false;
  // 通话按钮根据是否私聊启用
  if (selectedContact) {
    $('voiceCallBtn').disabled = false;
    $('videoCallBtn').disabled = false;
  }
  updateSendVsMic();
}

function showChatOnMobile() {
  const sidebar = document.querySelector('#tab-chat .sidebar');
  const chatArea = document.querySelector('#tab-chat .chat-area');
  if (sidebar) sidebar.classList.add('slide-out');
  if (chatArea) chatArea.classList.add('slide-in');
}

function showContactsOnMobile() {
  const sidebar = document.querySelector('#tab-chat .sidebar');
  const chatArea = document.querySelector('#tab-chat .chat-area');
  if (sidebar) sidebar.classList.remove('slide-out');
  if (chatArea) chatArea.classList.remove('slide-in');
}

function resetChatSelection() {
  selectedContact = null;
  selectedGroup = null;
  $('chatPartnerName').textContent = '选择一个会话';
  $('chatPartnerStatus').textContent = '未选择';
  $('chatPartnerAvatar').textContent = '?';
  $('chatPartnerAvatar').style.background = 'linear-gradient(135deg, #BF5AF2, #5856D6)';
  $('messageInput').disabled = true;
  $('sendBtn').disabled = true;
  $('imageBtn').disabled = true;
  $('videoSendBtn').disabled = true;
  $('fileBtn').disabled = true;
  $('emojiBtn').disabled = true;
  $('voiceRecordBtn').disabled = true;
  $('voiceCallBtn').disabled = true;
  $('videoCallBtn').disabled = true;
  $('messagesContainer').innerHTML = `
    <div class="messages-welcome">
      <div class="welcome-icon">💬</div>
      <p>选择一个会话开始聊天</p>
      <p class="welcome-hint">支持文字、图片、视频、语音消息及语音/视频通话</p>
    </div>`;
  showContactsOnMobile();
}

// TG 风格：输入为空显示麦克风，有内容显示发送
function updateSendVsMic() {
  const text = ($('messageInput')?.value || '').trim();
  if (text) {
    $('sendBtn').style.display = 'flex';
    $('voiceRecordBtn').style.display = 'none';
  } else {
    $('sendBtn').style.display = 'none';
    $('voiceRecordBtn').style.display = 'flex';
  }
}

// ====================== 聊天消息渲染（增强：撤回 / 已读 / 语音）======================
async function renderMessages() {
  const conv = getCurrentConversation();
  if (!conv) return;
  const msgs = conv.messages;

  if (msgs.length === 0) {
    const who = conv.type === 'group' ? selectedGroup.name : (selectedContact ? selectedContact.name : '');
    $('messagesContainer').innerHTML = `
      <div class="messages-welcome">
        <div class="welcome-icon">💬</div>
        <p>开始和 ${escapeHtml(who)} 聊天吧</p>
      </div>`;
    return;
  }

  // 异步渲染：先输出结构，图片/视频/语音/文件异步解密
  const htmlParts = msgs.map((m, index) => {
    const isSent = m.from === myId;
    let content = '';

    // 撤回消息
    if (m.recalled) {
      content = `<div class="message-recalled">消息已撤回</div>`;
    } else if (m.mediaType === 'image') {
      const placeholderId = `media-${index}-${m.timestamp}`;
      if (m.from !== myId) {
        // 对方发来的：异步解密
        content = `<div id="${placeholderId}" class="media-loading">🔓 解密中...</div>`;
        fetchAndDecryptFile(m.content, m.from).then(blobUrl => {
          const el = document.getElementById(placeholderId);
          if (el) el.outerHTML = `<img src="${blobUrl}" alt="图片" onclick="window.open('${blobUrl}','_blank')" onerror="this.parentElement.innerHTML='[图片加载失败]'">`;
        }).catch(() => {
          const el = document.getElementById(placeholderId);
          if (el) el.textContent = '[图片解密失败]';
        });
      } else {
        // 自己发的：直接显示（添加 onerror 处理服务器文件丢失）
        const selfImgUrl = absUrl(m.content);
        content = `<img src="${selfImgUrl}" alt="图片" onclick="window.open('${selfImgUrl}','_blank')" onerror="this.outerHTML='[图片已失效]'" style="max-width:200px;border-radius:12px;">`;
      }
    } else if (m.mediaType === 'video') {
      const placeholderId = `media-${index}-${m.timestamp}`;
      if (m.from !== myId) {
        content = `<div id="${placeholderId}" class="media-loading">🔓 解密中...</div>`;
        fetchAndDecryptFile(m.content, m.from).then(blobUrl => {
          const el = document.getElementById(placeholderId);
          if (el) el.outerHTML = `<video src="${blobUrl}" controls style="max-width:200px;border-radius:12px;"></video>`;
        }).catch(() => {
          const el = document.getElementById(placeholderId);
          if (el) el.textContent = '[视频解密失败]';
        });
      } else {
        content = `<video src="${absUrl(m.content)}" controls style="max-width:200px;border-radius:12px;" onerror="this.outerHTML='[视频已失效]'"></video>`;
      }
    } else if (m.mediaType === 'audio') {
      // 语音消息
      const dur = m.duration || 0;
      const placeholderId = `voice-${index}-${m.timestamp}`;
      content = `<div class="voice-msg" id="${placeholderId}" onclick="playVoiceMessage('${m.content}', ${m.from}, this)">
        <span class="play-icon">▶</span>
        <span class="voice-bar">${renderVoiceBars(dur)}</span>
        <span class="voice-dur">${dur}"</span>
      </div>`;
      // 对方发来的语音需解密
      if (m.from !== myId) {
        const el0 = null; // 占位，实际在点击时解密
      }
    } else if (m.mediaType === 'file') {
      const name = escapeHtml(m.fileName || '文件');
      if (m.from !== myId) {
        content = `<a href="#" onclick="downloadDecryptedFile('${m.content}', ${m.from}, '${escapeHtml(m.fileName || 'file')}');return false;" style="color:inherit;text-decoration:underline;">📎 ${name}</a>`;
      } else {
        content = `<a href="${m.content}" download="${name}" style="color:inherit;text-decoration:underline;">📎 ${name}</a>`;
      }
    } else {
      // 文本
      content = `<div>${escapeHtml(m.content)}</div>`;
    }

    // 已读回执（仅自己发送的文本）
    const readMark = (isSent && m.mediaType === 'text' && !m.recalled)
      ? `<div class="message-read">${m.read ? '已读' : '已送达'}</div>` : '';

    // 长按菜单数据（仅自己发送且 2 分钟内可撤回）
    const canRecall = isSent && !m.recalled && (Date.now() - m.timestamp < 2 * 60 * 1000);
    const dataAttrs = `data-ts="${m.timestamp}" data-from="${m.from}" data-type="${conv.type}" data-canrecall="${canRecall ? 1 : 0}" data-content="${escapeHtml(m.mediaType === 'text' ? (m.content || '') : '')}"`;

    return `
      <div class="message-row ${isSent ? 'sent' : 'received'}">
        <div>
          ${(conv.type === 'group' && !isSent) ? `<div class="message-sender">${escapeHtml(m.name || '')}</div>` : ''}
          <div class="message-bubble long-pressable" ${dataAttrs}>${content}</div>
          <div class="message-meta">${formatTime(m.timestamp)}${isSent ? '' : ''}</div>
          ${readMark}
        </div>
      </div>`;
  }).join('');

  $('messagesContainer').innerHTML = htmlParts;

  // 绑定长按菜单
  attachLongPress();

  // 滚动到底部
  $('messagesContainer').scrollTop = $('messagesContainer').scrollHeight;
}

// 渲染语音条（随机高度的小竖条）
function renderVoiceBars(duration) {
  const count = Math.min(20, Math.max(5, Math.floor(duration / 0.3) + 5));
  let html = '';
  for (let i = 0; i < count; i++) {
    const h = 6 + Math.floor(Math.abs(Math.sin(i * 1.7)) * 16);
    html += `<i style="height:${h}px"></i>`;
  }
  return html;
}

// ====================== 发送 / 接收消息（保留加密逻辑）======================
async function sendMessage(content, mediaType = 'text', extra = {}) {
  // 群聊走群消息路径
  if (selectedGroup) {
    return sendGroupMessage(content, mediaType, extra);
  }
  if (!selectedContact) return;

  // 文字消息需要加密，图片/视频/语音/文件的 URL 不加密（文件本身已加密）
  let encryptedContent = content;
  if (mediaType === 'text') {
    try {
      encryptedContent = await encryptText(content, selectedContact.id);
    } catch (err) {
      showToast('加密失败，消息未发送');
      return;
    }
  }

  const timestamp = Date.now();
  sendWS({
    type: 'private-message',
    to: selectedContact.id,
    content: encryptedContent,
    mediaType,
    ...extra,
  });

  // 本地显示（存储明文）
  if (!conversations[selectedContact.id]) conversations[selectedContact.id] = [];
  conversations[selectedContact.id].push({
    from: myId,
    name: myName,
    content,
    mediaType,
    timestamp,
    ...extra,
  });

  saveChatHistory(); // 持久化聊天记录
  renderMessages();
  renderConversations();
}

async function receiveMessage(fromId, fromName, content, mediaType, timestamp) {
  // 解密内容
  let decryptedContent = content;
  if (mediaType === 'text') {
    try {
      decryptedContent = await decryptText(content, fromId);
    } catch (err) {
      decryptedContent = '[解密失败]';
    }
  }

  if (!conversations[fromId]) conversations[fromId] = [];
  conversations[fromId].push({
    from: fromId,
    name: fromName,
    content: decryptedContent,
    mediaType,
    timestamp,
  });

  saveChatHistory(); // 持久化聊天记录
  const key = convKey('private', fromId);
  if (selectedContact && selectedContact.id === fromId) {
    renderMessages();
    unreadCounts[key] = 0;
  } else {
    if (!mutedConversations.has(key)) {
      unreadCounts[key] = (unreadCounts[key] || 0) + 1;
      showToast(`${fromName}: ${previewMessage({ content: decryptedContent, mediaType, from: fromId })}`);
    }
  }
  renderConversations();
}

// ====================== 文件发送（加密后上传，无大小限制）======================
async function handleFileSelect(file, mediaType) {
  if (!file) return;
  // 群聊文件：群消息暂不端到端加密文件，走普通上传
  if (selectedGroup) {
    return handleGroupFileSelect(file, mediaType);
  }
  if (!selectedContact) return;

  const label = mediaType === 'image' ? '图片' : mediaType === 'video' ? '视频' : '文件';
  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  showToast(`正在加密并上传${label}（${sizeMB}MB）...`, 3000);

  try {
    const fileBuffer = await file.arrayBuffer();
    const encryptedBuffer = await encryptFile(fileBuffer, selectedContact.id);
    const encryptedBlob = new Blob([encryptedBuffer]);

    const formData = new FormData();
    formData.append('file', encryptedBlob, 'encrypted.dat');
    formData.append('mediaType', mediaType === 'file' ? 'file' : mediaType);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', absUrl('/upload'));

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        showToast(`上传中 ${percent}%`, 1500);
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        const res = JSON.parse(xhr.responseText);
        const extra = mediaType === 'file' ? { fileName: file.name } : {};
        sendMessage(res.url, mediaType, extra);
        showToast(`${label}发送成功`, 1500);
      } else {
        showToast(`上传失败：${xhr.status}`, 3000);
      }
    };

    xhr.onerror = () => showToast('网络错误，上传失败', 3000);
    xhr.send(formData);
  } catch (err) {
    console.error('文件加密失败:', err);
    showToast('文件加密失败', 3000);
  }
}

// ====================== 消息撤回 ======================
function recallMessage(timestamp) {
  const conv = getCurrentConversation();
  if (!conv) return;

  // 仅发送者可在 2 分钟内撤回
  const msgs = conv.messages;
  const m = msgs.find(x => x.timestamp === timestamp);
  if (!m || m.from !== myId) {
    showToast('只能撤回自己发送的消息');
    return;
  }
  if (Date.now() - timestamp > 2 * 60 * 1000) {
    showToast('超过 2 分钟，无法撤回');
    return;
  }

  // 发送撤回通知
  if (conv.type === 'private') {
    sendWS({ type: 'message-recall', to: conv.id, timestamp, messageType: 'private' });
  } else {
    // 群撤回：通知所有群成员
    const g = groupConversations[conv.id];
    if (g) {
      g.members.forEach(mid => {
        if (mid !== myId) {
          sendWS({ type: 'message-recall', to: mid, groupId: conv.id, timestamp, messageType: 'group' });
        }
      });
    }
  }

  // 本地立即更新
  m.recalled = true;
  renderMessages();
  renderConversations();
  showToast('消息已撤回');
}

// 处理收到的撤回通知
function handleRecall(data) {
  const ts = data.timestamp;
  let updated = false;

  if (data.messageType === 'group' || data.groupId != null) {
    const g = groupConversations[data.groupId];
    if (g) {
      const m = g.messages.find(x => x.timestamp === ts);
      if (m) { m.recalled = true; updated = true; }
    }
  } else {
    const arr = conversations[data.from];
    if (arr) {
      const m = arr.find(x => x.timestamp === ts);
      if (m) { m.recalled = true; updated = true; }
    }
  }

  if (updated) {
    saveChatHistory(); // 持久化撤回状态
    const conv = getCurrentConversation();
    if (conv && (
      (data.messageType === 'group' && selectedGroup && selectedGroup.id === data.groupId) ||
      (data.messageType !== 'group' && selectedContact && selectedContact.id === data.from)
    )) {
      renderMessages();
    }
    renderConversations();
  }
}

// ====================== 群聊 ======================

// 打开建群模态框（选择成员）
function openCreateGroupModal() {
  // 候选成员：在线用户 + 好友
  const candidates = [];
  const seen = new Set();
  onlineUsers.forEach(u => { if (!seen.has(u.id)) { seen.add(u.id); candidates.push(u); } });
  friends.forEach(f => { if (!seen.has(f.id)) { seen.add(f.id); candidates.push({ id: f.id, name: f.username }); } });

  if (candidates.length === 0) {
    showToast('暂无可选成员，先添加好友或等对方上线');
    return;
  }

  pendingGroupMembers = [];
  const html = `
    <div class="modal-title">创建群聊</div>
    <div class="modal-body">
      <input type="text" id="newGroupName" class="glass-input" placeholder="群聊名称" maxlength="30">
      <div class="member-pick-list">
        ${candidates.map(u => `
          <label class="member-pick-item">
            <input type="checkbox" value="${u.id}" onchange="toggleGroupMember(${u.id}, this.checked)">
            <div class="conv-avatar" style="width:32px;height:32px;font-size:13px;background:${getAvatarColor(u.name)}">${getInitial(u.name)}</div>
            <span>${escapeHtml(u.name)}</span>
          </label>`).join('')}
      </div>
    </div>
    <div class="modal-actions">
      <button class="glass-btn-link" onclick="closeGenericModal()">取消</button>
      <button class="glass-btn-primary" onclick="confirmCreateGroup()">创建</button>
    </div>`;
  openGenericModal(html);
}

function toggleGroupMember(id, checked) {
  if (checked) {
    if (!pendingGroupMembers.includes(id)) pendingGroupMembers.push(id);
  } else {
    pendingGroupMembers = pendingGroupMembers.filter(x => x !== id);
  }
}

function confirmCreateGroup() {
  const name = ($('newGroupName')?.value || '').trim();
  if (!name) { showToast('请输入群聊名称'); return; }
  if (pendingGroupMembers.length === 0) { showToast('请至少选择一位成员'); return; }
  createGroup(name, pendingGroupMembers);
  closeGenericModal();
}

// 创建群聊：本地生成群 ID，向每个成员发送 group-invite（需后端转发 group-message/group-invite）
function createGroup(name, memberIds) {
  const groupId = `g_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const members = [myId, ...memberIds];
  groupConversations[groupId] = {
    id: groupId,
    name,
    members,
    messages: [],
  };

  // 通知成员加入群聊（通过 group-invite，需后端支持转发）
  memberIds.forEach(mid => {
    sendWS({
      type: 'group-invite',
      to: mid,
      groupId,
      groupName: name,
      members,
      inviter: myId,
      inviterName: myName,
    });
  });

  showToast(`群聊「${name}」已创建`);
  renderConversations();
  selectGroup(groupId);
}

// 收到群邀请：加入群聊
function handleGroupInvite(data) {
  if (groupConversations[data.groupId]) return; // 已存在
  groupConversations[data.groupId] = {
    id: data.groupId,
    name: data.groupName,
    members: data.members || [data.inviter, myId],
    messages: [],
  };
  showToast(`${data.inviterName || '有人'} 邀请你加入群聊「${data.groupName}」`);
  renderConversations();
}

// 发送群消息
async function sendGroupMessage(content, mediaType = 'text', extra = {}) {
  if (!selectedGroup) return;
  const g = groupConversations[selectedGroup.id];
  if (!g) return;

  const timestamp = Date.now();

  // 向每位成员发送（除自己）。文字消息按成员逐一加密实现端到端
  for (const mid of g.members) {
    if (mid === myId) continue;
    if (mediaType === 'text') {
      let enc = content;
      try { enc = await encryptText(content, mid); } catch { /* 无密钥则明文 */ }
      sendWS({
        type: 'group-message',
        to: mid,
        groupId: g.id,
        groupName: g.name,
        content: enc,
        mediaType: 'text',
        timestamp,
      });
    } else {
      // 群媒体：URL 明文（文件本身在群场景下未逐成员加密）
      sendWS({
        type: 'group-message',
        to: mid,
        groupId: g.id,
        groupName: g.name,
        content,
        mediaType,
        timestamp,
        ...extra,
      });
    }
  }

  // 本地存储
  g.messages.push({
    from: myId,
    name: myName,
    content,
    mediaType,
    timestamp,
    ...extra,
  });

  saveChatHistory(); // 持久化聊天记录
  renderMessages();
  renderConversations();
}

// 群文件上传（不加密，普通上传）
async function handleGroupFileSelect(file, mediaType) {
  if (!selectedGroup || !file) return;
  const label = mediaType === 'image' ? '图片' : mediaType === 'video' ? '视频' : '文件';
  showToast(`正在上传群${label}...`, 2000);

  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('mediaType', mediaType === 'file' ? 'file' : mediaType);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', absUrl('/upload'));
  xhr.onload = () => {
    if (xhr.status === 200) {
      const res = JSON.parse(xhr.responseText);
      const extra = mediaType === 'file' ? { fileName: file.name } : {};
      sendGroupMessage(res.url, mediaType, extra);
      showToast(`${label}发送成功`, 1500);
    } else {
      showToast(`上传失败：${xhr.status}`, 3000);
    }
  };
  xhr.onerror = () => showToast('网络错误，上传失败', 3000);
  xhr.send(formData);
}

// 接收群消息
async function receiveGroupMessage(data) {
  const gid = data.groupId;
  if (!groupConversations[gid]) {
    // 自动建群（兼容直接收到群消息但未收到邀请的情况）
    groupConversations[gid] = {
      id: gid,
      name: data.groupName || '群聊',
      members: [data.from, myId],
      messages: [],
    };
  }
  const g = groupConversations[gid];

  // 解密文字
  let content = data.content;
  if (data.mediaType === 'text') {
    try { content = await decryptText(data.content, data.from); }
    catch { content = '[解密失败]'; }
  }

  g.messages.push({
    from: data.from,
    name: data.name || data.fromName || `用户${data.from}`,
    content,
    mediaType: data.mediaType,
    timestamp: data.timestamp,
    duration: data.duration,
    fileName: data.fileName,
  });

  saveChatHistory(); // 持久化聊天记录
  const key = convKey('group', gid);
  if (selectedGroup && selectedGroup.id === gid) {
    renderMessages();
    unreadCounts[key] = 0;
  } else {
    if (!mutedConversations.has(key)) {
      unreadCounts[key] = (unreadCounts[key] || 0) + 1;
      showToast(`[${g.name}] ${data.name || ''}: ${previewMessage({ content, mediaType: data.mediaType, from: data.from })}`);
    }
  }
  renderConversations();
}

// ====================== 语音消息 ======================
function startRecording() {
  if (!selectedContact && !selectedGroup) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('当前浏览器不支持语音录制');
    return;
  }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    mediaRecorder = new MediaRecorder(stream);
    recordedChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      const duration = Math.max(1, Math.round((Date.now() - recordStartTime) / 1000));
      stopRecordTimer();
      stream.getTracks().forEach(t => t.stop());
      uploadVoiceMessage(blob, duration);
    };
    mediaRecorder.start();
    recordStartTime = Date.now();
    $('voiceRecordBtn').classList.add('recording');
    $('voiceRecordBtn').title = '正在录音，再次点击停止';
    startRecordTimer();
  }).catch(err => {
    console.error('录音权限失败:', err);
    showToast('无法访问麦克风，请检查权限');
  });
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  $('voiceRecordBtn').classList.remove('recording');
  $('voiceRecordBtn').title = '按住录音';
}

function startRecordTimer() {
  let s = 0;
  recordTimerInterval = setInterval(() => {
    s++;
    $('voiceRecordBtn').title = `正在录音 ${s}s，再次点击停止`;
  }, 1000);
}

function stopRecordTimer() {
  if (recordTimerInterval) { clearInterval(recordTimerInterval); recordTimerInterval = null; }
}

// 上传语音文件（私聊加密，群聊普通上传）
async function uploadVoiceMessage(blob, duration) {
  if (selectedGroup) {
    // 群聊：普通上传
    const formData = new FormData();
    formData.append('file', blob, 'voice.webm');
    formData.append('mediaType', 'audio');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', absUrl('/upload'));
    xhr.onload = () => {
      if (xhr.status === 200) {
        const res = JSON.parse(xhr.responseText);
        sendGroupMessage(res.url, 'audio', { duration });
      } else {
        showToast('语音上传失败', 2000);
      }
    };
    xhr.send(formData);
    return;
  }

  if (!selectedContact) return;
  showToast('正在加密并上传语音...', 2000);
  try {
    const buf = await blob.arrayBuffer();
    const encBuf = await encryptFile(buf, selectedContact.id);
    const encBlob = new Blob([encBuf]);
    const formData = new FormData();
    formData.append('file', encBlob, 'voice.enc');
    formData.append('mediaType', 'audio');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', absUrl('/upload'));
    xhr.onload = () => {
      if (xhr.status === 200) {
        const res = JSON.parse(xhr.responseText);
        sendMessage(res.url, 'audio', { duration });
      } else {
        showToast('语音上传失败', 2000);
      }
    };
    xhr.send(formData);
  } catch (err) {
    console.error('语音加密失败:', err);
    showToast('语音加密失败', 2000);
  }
}

// 播放语音消息（对方发来的需先解密）
async function playVoiceMessage(url, fromId, el) {
  try {
    let blobUrl = voiceBlobCache[url];
    if (!blobUrl) {
      if (fromId === myId) {
        // 自己发的：直接播放
        blobUrl = url;
      } else {
        const resp = await fetch(absUrl(url));
        const encBuf = await resp.arrayBuffer();
        const decBuf = await decryptFile(encBuf, fromId);
        blobUrl = URL.createObjectURL(new Blob([decBuf], { type: 'audio/webm' }));
        voiceBlobCache[url] = blobUrl;
      }
    }
    const audio = new Audio(blobUrl);
    if (el) {
      el.querySelector('.play-icon').textContent = '⏸';
      audio.onended = () => { el.querySelector('.play-icon').textContent = '▶'; };
    }
    audio.play();
  } catch (err) {
    console.error('语音播放失败:', err);
    showToast('语音播放失败');
  }
}

// 下载解密文件
async function downloadDecryptedFile(url, fromId, fileName) {
  try {
    const resp = await fetch(absUrl(url));
    const encBuf = await resp.arrayBuffer();
    const decBuf = await decryptFile(encBuf, fromId);
    const blobUrl = URL.createObjectURL(new Blob([decBuf]));
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = fileName || 'file';
    a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  } catch (err) {
    showToast('文件解密失败');
  }
}

// ====================== 消息上下文菜单（长按）======================
let longPressTimer = null;
let longPressTarget = null;

function attachLongPress() {
  document.querySelectorAll('.message-bubble.long-pressable').forEach(bubble => {
    // 触摸长按
    bubble.addEventListener('touchstart', (e) => {
      longPressTarget = bubble;
      longPressTimer = setTimeout(() => showMessageContextMenu(bubble, e), 500);
    }, { passive: true });
    bubble.addEventListener('touchend', () => clearTimeout(longPressTimer));
    bubble.addEventListener('touchmove', () => clearTimeout(longPressTimer));
    // 鼠标右键
    bubble.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMessageContextMenu(bubble, e);
    });
  });
}

function showMessageContextMenu(bubble, e) {
  const menu = $('messageContextMenu');
  const ts = Number(bubble.dataset.ts);
  const canRecall = bubble.dataset.canrecall === '1';
  const textContent = bubble.dataset.content || '';
  const type = bubble.dataset.type;

  // 撤回按钮仅可撤回时显示
  menu.querySelector('[data-action="recall"]').style.display = canRecall ? 'block' : 'none';
  menu.querySelector('hr').style.display = canRecall ? 'block' : 'none';

  // 定位菜单
  const x = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
  const y = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
  menu.style.left = Math.min(x, window.innerWidth - 140) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 160) + 'px';
  menu.classList.remove('hidden');

  // 缓存上下文
  menu._ctx = { ts, textContent, type, bubble };
}

function hideMessageContextMenu() {
  $('messageContextMenu').classList.add('hidden');
}

function handleContextAction(action) {
  const ctx = $('messageContextMenu')._ctx;
  if (!ctx) return;
  hideMessageContextMenu();

  if (action === 'recall') {
    recallMessage(ctx.ts);
  } else if (action === 'copy') {
    const text = ctx.textContent;
    if (text) {
      navigator.clipboard?.writeText(text).then(() => showToast('已复制')).catch(() => showToast('复制失败'));
    } else {
      showToast('该消息不支持复制');
    }
  } else if (action === 'forward') {
    openForwardModal(ctx.textContent);
  }
}

// 转发消息：选择一个会话转发
function openForwardModal(text) {
  if (!text) { showToast('仅支持转发文本消息'); return; }
  forwardMessageCache = text;

  // 收集可转发的会话
  const targets = [];
  onlineUsers.forEach(u => targets.push({ type: 'private', id: u.id, name: u.name }));
  Object.values(groupConversations).forEach(g => targets.push({ type: 'group', id: g.id, name: g.name }));

  if (targets.length === 0) { showToast('暂无可转发的会话'); return; }

  const html = `
    <div class="modal-title">转发到</div>
    <div class="modal-body">
      <div class="search-results">
        ${targets.map(t => `
          <div class="member-pick-item" onclick="confirmForward('${t.type}', '${t.id}')">
            <div class="conv-avatar" style="width:32px;height:32px;font-size:13px;background:${getAvatarColor(t.name)}">${getInitial(t.name)}</div>
            <span>${escapeHtml(t.name)}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="modal-actions"><button class="glass-btn-link" onclick="closeGenericModal()">取消</button></div>`;
  openGenericModal(html);
}

async function confirmForward(type, id) {
  if (!forwardMessageCache) return;
  closeGenericModal();
  if (type === 'group') {
    const g = groupConversations[id];
    if (g) {
      const prev = selectedGroup;
      selectedGroup = g;
      await sendGroupMessage(forwardMessageCache, 'text');
      selectedGroup = prev;
      showToast('已转发');
    }
  } else {
    const user = onlineUsers.find(u => String(u.id) === String(id));
    if (user) {
      const prev = selectedContact;
      selectedContact = user;
      await sendMessage(forwardMessageCache, 'text');
      selectedContact = prev;
      showToast('已转发');
    }
  }
  forwardMessageCache = null;
}

// ====================== 好友系统 ======================

// 加载好友 / 好友请求 / 屏蔽列表
async function loadFriends() {
  try {
    const data = await api('friends');
    friends = data.friends || [];
    friendRequests = data.requests || [];
    blockedUsers = data.blocked || [];
  } catch (err) {
    // 接口未实现：保持空列表
    friends = []; friendRequests = []; blockedUsers = [];
  }
  renderFriendsList();
  renderFriendRequests();
  renderBlockedList();
  renderConversations();
}

// 搜索用户（从已通过用户中过滤）
async function searchUser(keyword) {
  try {
    const data = await api('all-approved-users');
    const list = data.users || [];
    return list.filter(u => u.username.toLowerCase().includes(keyword.toLowerCase())
                        && u.id !== myDbId);
  } catch (err) {
    // 接口未实现（非管理员可能无权限），回退用在线用户
    return onlineUsers
      .filter(u => u.name.toLowerCase().includes(keyword.toLowerCase()))
      .map(u => ({ id: u.id, username: u.name }));
  }
}

// 打开添加好友模态框
async function openAddFriendModal() {
  const html = `
    <div class="modal-title">添加朋友</div>
    <div class="modal-body">
      <input type="text" id="friendSearchInput" class="glass-input" placeholder="输入用户名搜索" oninput="onFriendSearchInput()">
      <div class="search-results" id="friendSearchResults"><div class="empty-state">输入用户名开始搜索</div></div>
    </div>
    <div class="modal-actions"><button class="glass-btn-link" onclick="closeGenericModal()">关闭</button></div>`;
  openGenericModal(html);
}

let friendSearchTimer = null;
function onFriendSearchInput() {
  clearTimeout(friendSearchTimer);
  const kw = $('friendSearchInput').value.trim();
  if (!kw) {
    $('friendSearchResults').innerHTML = '<div class="empty-state">输入用户名开始搜索</div>';
    return;
  }
  friendSearchTimer = setTimeout(async () => {
    const results = await searchUser(kw);
    if (results.length === 0) {
      $('friendSearchResults').innerHTML = '<div class="empty-state">未找到用户</div>';
      return;
    }
    $('friendSearchResults').innerHTML = results.map(u => `
      <div class="member-pick-item">
        <div class="conv-avatar" style="width:32px;height:32px;font-size:13px;background:${getAvatarColor(u.username)}">${getInitial(u.username)}</div>
        <span style="flex:1">${escapeHtml(u.username)}${u.online ? ' <span style="color:var(--green);font-size:12px;">在线</span>' : ' <span style="color:var(--gray);font-size:12px;">离线</span>'}</span>
        <button class="mini-btn blue" onclick="sendFriendRequest(${u.id})">加好友</button>
      </div>`).join('');
  }, 300);
}

// 发送好友请求
async function sendFriendRequest(userId) {
  try {
    await api('add-friend', 'POST', { userId });
    showToast('好友请求已发送');
  } catch (err) {
    showToast('发送失败: ' + err.message);
  }
}

// 接受好友请求
async function acceptFriendRequest(userId) {
  try {
    await api('accept-friend', 'POST', { userId });
    showToast('已添加好友');
    loadFriends();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// 拒绝好友请求
async function rejectFriendRequest(userId) {
  try {
    await api('reject-friend', 'POST', { userId });
    showToast('已拒绝');
    loadFriends();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// 删除好友
async function removeFriend(userId) {
  if (!confirm('确定删除该好友？')) return;
  try {
    await api('remove-friend', 'POST', { userId });
    showToast('已删除好友');
    loadFriends();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// 屏蔽用户
async function blockUser(userId) {
  if (!confirm('确定屏蔽该用户？')) return;
  try {
    await api('block-user', 'POST', { userId });
    showToast('已屏蔽');
    loadFriends();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// 取消屏蔽
async function unblockUser(userId) {
  try {
    await api('unblock-user', 'POST', { userId });
    showToast('已取消屏蔽');
    loadFriends();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

function renderFriendsList() {
  const list = $('friendsList');
  if (!list) return;
  if (friends.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无好友，点击右上角添加</div>';
  } else {
    list.innerHTML = friends.map(f => {
      const online = isUserOnline(f.id);
      return `
        <div class="friend-item">
          <div class="conv-avatar" style="background:${getAvatarColor(f.username)}">${getInitial(f.username)}${online ? '<span class="conv-online"></span>' : ''}</div>
          <div class="friend-info">
            <div class="friend-name">${escapeHtml(f.username)}</div>
            <div class="friend-status">${online ? '在线' : '离线'}</div>
          </div>
          <div class="friend-actions">
            <button class="mini-btn blue" onclick="startChatWithFriend(${f.id})">发消息</button>
            <button class="mini-btn neutral" onclick="removeFriend(${f.id})">删除</button>
            <button class="mini-btn reject" onclick="blockUser(${f.id})">屏蔽</button>
          </div>
        </div>`;
    }).join('');
  }
  // 同时渲染在线用户列表
  renderOnlineUsersList();
}

/** 渲染在线用户列表（通讯录页面，用于发现其他在线用户） */
function renderOnlineUsersList() {
  var list = $('onlineUsersList');
  if (!list) return;
  if (onlineUsers.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无其他在线用户</div>';
    return;
  }
  // 过滤掉已经是好友的
  var friendIds = friends.map(f => f.id);
  var displayUsers = onlineUsers.filter(u => !friendIds.includes(u.id));

  if (displayUsers.length === 0) {
    list.innerHTML = '<div class="empty-state">所有在线用户已是你的好友</div>';
    return;
  }
  list.innerHTML = displayUsers.map(u => `
    <div class="friend-item">
      <div class="conv-avatar" style="background:${getAvatarColor(u.name)}">${getInitial(u.name)}<span class="conv-online"></span></div>
      <div class="friend-info">
        <div class="friend-name">${escapeHtml(u.name)}</div>
        <div class="friend-status" style="color:var(--green);">在线</div>
      </div>
      <div class="friend-actions">
        <button class="mini-btn blue" onclick="sendFriendRequestById('${u.id}')">加好友</button>
        <button class="mini-btn neutral" onclick="chatWithOnlineUser('${u.id}')">发消息</button>
      </div>
    </div>`).join('');
}

/** 向在线用户发送好友请求（通过在线用户ID） */
async function sendFriendRequestById(onlineId) {
  // onlineId 可能是 WebSocket 分配的 ID（等于数据库 user.id）
  try {
    await api('add-friend', 'POST', { userId: parseInt(onlineId) });
    showToast('好友请求已发送');
  } catch (err) {
    showToast('发送失败: ' + err.message);
  }
}

/** 直接与在线用户开始聊天 */
function chatWithOnlineUser(onlineId) {
  var user = onlineUsers.find(u => String(u.id) === String(onlineId));
  if (!user) {
    showToast('用户已下线');
    return;
  }
  switchTab('chat');
  selectContact(parseInt(onlineId));
}

function renderFriendRequests() {
  const list = $('friendRequestsList');
  if (!list) return;
  if (friendRequests.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无好友请求</div>';
    return;
  }
  list.innerHTML = friendRequests.map(r => `
    <div class="friend-item">
      <div class="conv-avatar" style="background:${getAvatarColor(r.username)}">${getInitial(r.username)}</div>
      <div class="friend-info">
        <div class="friend-name">${escapeHtml(r.username)}</div>
        <div class="friend-status">请求添加你为好友</div>
      </div>
      <div class="friend-actions">
        <button class="mini-btn accept" onclick="acceptFriendRequest(${r.id})">接受</button>
        <button class="mini-btn reject" onclick="rejectFriendRequest(${r.id})">拒绝</button>
      </div>
    </div>`).join('');
}

function renderBlockedList() {
  const list = $('blockedList');
  if (!list) return;
  if (blockedUsers.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无屏蔽用户</div>';
    return;
  }
  list.innerHTML = blockedUsers.map(b => `
    <div class="friend-item">
      <div class="conv-avatar" style="background:${getAvatarColor(b.username)}">${getInitial(b.username)}</div>
      <div class="friend-info">
        <div class="friend-name">${escapeHtml(b.username)}</div>
        <div class="friend-status">已屏蔽</div>
      </div>
      <div class="friend-actions">
        <button class="mini-btn blue" onclick="unblockUser(${b.id})">取消屏蔽</button>
      </div>
    </div>`).join('');
}

// 从通讯录发起聊天（好友可能不在线，仍可建立会话占位）
function startChatWithFriend(friendId) {
  switchTab('chat');
  const f = friends.find(x => x.id === friendId);
  if (!f) return;
  // 若对方在线，selectContact 会用 onlineUsers 中的真实对象（含 publicKey）
  const onlineUser = onlineUsers.find(u => u.id === friendId);
  if (onlineUser) {
    selectContact(friendId);
  } else {
    // 离线好友：建立占位会话
    if (!conversations[friendId]) conversations[friendId] = [];
    selectedContact = { id: friendId, name: f.username };
    selectedGroup = null;
    $('chatPartnerName').textContent = f.username;
    $('chatPartnerStatus').textContent = '离线';
    $('chatPartnerAvatar').textContent = getInitial(f.username);
    $('chatPartnerAvatar').style.background = getAvatarColor(f.username);
    enableInput();
    // 离线无法加密发送，但仍允许尝试
    renderMessages();
    renderConversations();
    showChatOnMobile();
  }
}

// ====================== 社区 ======================

// 加载频道列表
async function loadChannels() {
  try {
    const data = await api('channels');
    channels = data.channels || [];
  } catch (err) {
    channels = [];
  }
  renderChannels();
}

function renderChannels() {
  const list = $('channelList');
  if (!list) return;
  if (channels.length === 0) {
    list.innerHTML = '<div class="empty-state">暂无频道，点击新建</div>';
    return;
  }
  list.innerHTML = channels.map(c => `
    <div class="channel-item ${selectedChannel && selectedChannel.id === c.id ? 'active' : ''}" onclick="selectChannel(${c.id})">
      <div class="channel-name">${escapeHtml(c.name)}</div>
      <div class="channel-desc">${escapeHtml(c.description || '暂无简介')}</div>
    </div>`).join('');
}

// 打开创建频道模态框
function openCreateChannelModal() {
  const html = `
    <div class="modal-title">新建频道</div>
    <div class="modal-body">
      <input type="text" id="newChannelName" class="glass-input" placeholder="频道名称" maxlength="30">
      <input type="text" id="newChannelDesc" class="glass-input" placeholder="频道简介（可选）" maxlength="100">
    </div>
    <div class="modal-actions">
      <button class="glass-btn-link" onclick="closeGenericModal()">取消</button>
      <button class="glass-btn-primary" onclick="confirmCreateChannel()">创建</button>
    </div>`;
  openGenericModal(html);
}

async function confirmCreateChannel() {
  const name = ($('newChannelName')?.value || '').trim();
  const description = ($('newChannelDesc')?.value || '').trim();
  if (!name) { showToast('请输入频道名称'); return; }
  try {
    await api('create-channel', 'POST', { name, description });
    showToast('频道已创建');
    closeGenericModal();
    loadChannels();
  } catch (err) {
    showToast('创建失败: ' + err.message);
  }
}

async function selectChannel(channelId) {
  const c = channels.find(x => x.id === channelId);
  if (!c) return;
  selectedChannel = c;
  $('channelTitle').textContent = c.name;
  $('channelMeta').textContent = c.description || '查看与发布动态';
  $('postInput').disabled = false;
  $('postImageBtn').disabled = false;
  $('postSendBtn').disabled = false;
  $('channelInviteBtn').disabled = false;
  // 移动端：切换到频道详情视图
  document.querySelector('.community-page')?.classList.add('show-detail');
  renderChannels();
  renderChannelDetail();
}

// 返回频道列表（移动端）
function backToChannelList() {
  document.querySelector('.community-page')?.classList.remove('show-detail');
}

let pendingPostImages = []; // 待发布图片（base64/dataURL）

async function renderChannelDetail() {
  if (!selectedChannel) return;
  const container = $('postsContainer');
  container.innerHTML = '<div class="empty-state">加载中...</div>';
  try {
    const data = await api(`channel-posts?channelId=${selectedChannel.id}`);
    renderPosts(data.posts || []);
  } catch (err) {
    container.innerHTML = '<div class="empty-state">暂无动态，发布第一条吧</div>';
  }
}

function renderPosts(posts) {
  const container = $('postsContainer');
  if (!posts || posts.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无动态，发布第一条吧</div>';
    return;
  }
  container.innerHTML = posts.map(p => `
    <div class="post-card">
      <div class="post-header">
        <div class="conv-avatar" style="width:34px;height:34px;font-size:14px;background:${getAvatarColor(p.authorName || '匿名')}">${getInitial(p.authorName || '匿')}</div>
        <div>
          <div class="post-author">${escapeHtml(p.authorName || '匿名用户')}</div>
          <div class="post-time">${formatTime(p.createdAt)}</div>
        </div>
      </div>
      <div class="post-content">${escapeHtml(p.content)}</div>
      ${p.images && p.images.length ? `<div class="post-images">${p.images.map(img => `<img src="${absUrl(img)}" onclick="window.open('${absUrl(img)}','_blank')">`).join('')}</div>` : ''}
      <div class="post-actions">
        <span onclick="toggleCommentBox(${p.id})">💬 评论 (${(p.comments || []).length})</span>
      </div>
      <div class="comments-section" id="comments-${p.id}" style="display:none;">
        ${(p.comments || []).map(c => `<div class="comment-item"><b>${escapeHtml(c.authorName || '匿名')}:</b> ${escapeHtml(c.content)}</div>`).join('')}
        <div class="comment-input">
          <input type="text" id="comment-input-${p.id}" placeholder="写评论...">
          <button class="mini-btn blue" onclick="commentPost(${p.id})">发送</button>
        </div>
      </div>
    </div>`).join('');
}

function toggleCommentBox(postId) {
  const el = $(`comments-${postId}`);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function commentPost(postId) {
  if (!selectedChannel) return;
  const input = $(`comment-input-${postId}`);
  const content = (input?.value || '').trim();
  if (!content) return;
  try {
    await api('comment-post', 'POST', { channelId: selectedChannel.id, postId, content });
    input.value = '';
    showToast('评论成功');
    renderChannelDetail();
  } catch (err) {
    showToast('评论失败: ' + err.message);
  }
}

// 选择发布图片
function onPostImageSelect() {
  const input = $('postImageInput');
  const files = Array.from(input.files || []);
  if (files.length === 0) return;
  pendingPostImages = [];
  let loaded = 0;
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      pendingPostImages.push(e.target.result);
      loaded++;
      if (loaded === files.length) showToast(`已选择 ${files.length} 张图片`);
    };
    reader.readAsDataURL(file);
  });
  input.value = '';
}

// 发布动态
async function createPost() {
  if (!selectedChannel) return;
  const content = ($('postInput')?.value || '').trim();
  if (!content && pendingPostImages.length === 0) {
    showToast('请输入内容或选择图片');
    return;
  }
  try {
    await api('create-post', 'POST', {
      channelId: selectedChannel.id,
      content,
      images: pendingPostImages,
    });
    $('postInput').value = '';
    pendingPostImages = [];
    showToast('发布成功');
    renderChannelDetail();
  } catch (err) {
    showToast('发布失败: ' + err.message);
  }
}

// 生成频道邀请链接
function generateChannelInviteLink() {
  if (!selectedChannel) return;
  const link = `${location.origin}/?channel=${selectedChannel.id}`;
  navigator.clipboard?.writeText(link).then(() => showToast('邀请链接已复制')).catch(() => {
    window.prompt('复制邀请链接:', link);
  });
}

// ====================== 文件传输 ======================

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// 上传文件（带进度）
async function uploadTransferFile(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);

  const xhr = new XMLHttpRequest();
  $('uploadProgress').classList.remove('hidden');
  $('uploadResult').classList.add('hidden');
  $('progressFill').style.width = '0%';
  $('progressText').textContent = '上传中... 0%';

  xhr.upload.addEventListener('progress', (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      $('progressFill').style.width = pct + '%';
      $('progressText').textContent = `上传中... ${pct}%`;
    }
  });

  xhr.addEventListener('load', () => {
    $('uploadProgress').classList.add('hidden');
    try {
      const data = JSON.parse(xhr.responseText);
      if (data.success) {
        $('transferCode').textContent = data.code;
        $('transferFilename').textContent = data.filename + ' · ' + formatFileSize(data.size);
        $('uploadResult').classList.remove('hidden');
        showToast('上传成功，取件码：' + data.code);
      } else {
        showToast('上传失败：' + (data.error || '未知错误'));
      }
    } catch {
      showToast('上传失败：服务器返回异常');
    }
  });

  xhr.addEventListener('error', () => {
    $('uploadProgress').classList.add('hidden');
    showToast('上传失败：网络错误');
  });

  xhr.open('POST', absUrl('/api/transfer/upload'));
  xhr.setRequestHeader('Authorization', 'Bearer ' + authToken);
  xhr.send(formData);
}

// 通过取件码查询文件信息
async function queryTransferCode() {
  const code = $('downloadCodeInput').value.trim().toUpperCase();
  if (!code || code.length !== 6) {
    showToast('请输入6位取件码');
    return;
  }

  try {
    const data = await api(`transfer/info/${code}`);
    if (data.success) {
      $('downloadFilename').textContent = data.filename;
      $('downloadFilesize').textContent = formatFileSize(data.size);
      $('downloadUploader').textContent = '上传者：' + (data.uploadedByName || '匿名') + ' · 下载次数：' + data.downloads;
      $('downloadResult').classList.remove('hidden');
      // 存储当前查询的取件码供下载使用
      $('downloadFileBtn').dataset.code = code;
    }
  } catch (err) {
    showToast(err.message || '取件码无效');
    $('downloadResult').classList.add('hidden');
  }
}

// 下载文件（直接跳转URL，兼容移动端浏览器原生下载）
function downloadTransferFile() {
  const code = $('downloadFileBtn').dataset.code;
  if (!code) {
    showToast('请先查询取件码');
    return;
  }

  // 直接通过浏览器跳转下载，避免 fetch+blob 在移动端的限制
  const downloadUrl = absUrl(`/api/transfer/download?code=${encodeURIComponent(code)}&token=${encodeURIComponent(authToken)}`);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = $('downloadFilename').textContent || 'download';
  // 加 target=_blank 避免部分浏览器跳转后无法返回
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('下载已开始');
}

// 复制取件码
function copyTransferCode() {
  const code = $('transferCode').textContent;
  navigator.clipboard?.writeText(code).then(() => showToast('取件码已复制')).catch(() => {
    window.prompt('复制取件码:', code);
  });
}

// ====================== 管理员面板 ======================

function showAdminPanel() {
  $('chatScreen').classList.add('hidden');
  $('loginScreen').classList.add('hidden');
  $('adminScreen').classList.remove('hidden');
  switchAdminTab('users');
  loadPendingUsers();
  loadAllUsers();
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.adminTab === tab);
  });
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
  $(`adminTab-${tab}`)?.classList.remove('hidden');
  if (tab === 'logs') loadSystemLogs();
}

// 加载待审核用户
async function loadPendingUsers() {
  try {
    const data = await api('pending-users');
    const list = $('pendingUsersList');
    if (data.users.length === 0) {
      list.innerHTML = '<div class="admin-empty">暂无待审核用户</div>';
      return;
    }
    list.innerHTML = data.users.map(user => `
      <div class="admin-user-item">
        <div class="admin-user-info">
          <div class="admin-user-name">${escapeHtml(user.username)}</div>
          <div class="admin-user-meta">注册于 ${new Date(user.createdAt).toLocaleString('zh-CN')}</div>
        </div>
        <div class="admin-actions">
          <button class="admin-btn admin-btn-approve" onclick="approveUser(${user.id})">通过</button>
          <button class="admin-btn admin-btn-reject" onclick="rejectUser(${user.id})">拒绝</button>
        </div>
      </div>`).join('');
  } catch (err) {
    showToast('加载失败: ' + err.message);
  }
}

// 加载所有用户
async function loadAllUsers() {
  try {
    const data = await api('all-users');
    const list = $('allUsersList');
    if (data.users.length === 0) {
      list.innerHTML = '<div class="admin-empty">暂无用户</div>';
      return;
    }
    const statusMap = { 'approved': '已通过', 'pending': '待审核', 'rejected': '已拒绝' };
    list.innerHTML = data.users.map(user => `
      <div class="admin-user-item">
        <div class="admin-user-info">
          <div class="admin-user-name">${escapeHtml(user.username)}${user.role === 'admin' ? ' 👑' : ''}</div>
          <div class="admin-user-meta">ID: ${user.id} · 注册于 ${new Date(user.createdAt).toLocaleString('zh-CN')}</div>
        </div>
        <div class="admin-actions">
          ${user.role === 'admin'
            ? '<span class="admin-user-status admin">管理员</span>'
            : `<span class="admin-user-status ${user.status}">${statusMap[user.status] || user.status}</span>
               ${user.status === 'pending' ? `<button class="admin-btn admin-btn-approve" onclick="approveUser(${user.id})">通过</button>` : ''}
               ${user.status === 'approved' ? `<button class="admin-btn admin-btn-reject" onclick="banUser(${user.id})">禁用</button>` : ''}
               <button class="admin-btn admin-btn-reject" onclick="deleteUser(${user.id})">删除</button>`}
        </div>
      </div>`).join('');
  } catch (err) {
    showToast('加载失败: ' + err.message);
  }
}

// 审核通过用户
async function approveUser(userId) {
  try {
    await api('approve-user', 'POST', { userId });
    showToast('审核已通过');
    loadPendingUsers();
    loadAllUsers();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// 拒绝用户（复用 reject-user）
async function rejectUser(userId) {
  try {
    await api('reject-user', 'POST', { userId });
    showToast('已拒绝该用户');
    loadPendingUsers();
    loadAllUsers();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// 禁用用户（封禁）
async function banUser(userId) {
  if (!confirm('确定禁用该用户？')) return;
  try {
    await api('ban-user', 'POST', { userId });
    showToast('已禁用');
    loadAllUsers();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// 删除用户
async function deleteUser(userId) {
  if (!confirm('确定删除该用户？此操作不可恢复')) return;
  try {
    await api('delete-user', 'POST', { userId });
    showToast('已删除');
    loadAllUsers();
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// 加载系统日志
async function loadSystemLogs() {
  const container = $('systemLogs');
  try {
    const data = await api('system-logs');
    const logs = data.logs || [];
    if (logs.length === 0) {
      container.innerHTML = '<div class="admin-empty">暂无日志</div>';
      return;
    }
    container.innerHTML = logs.map(l => `<div class="log-item">[${new Date(l.time).toLocaleString('zh-CN')}] ${escapeHtml(l.message)}</div>`).join('');
  } catch (err) {
    container.innerHTML = '<div class="admin-empty">日志接口不可用</div>';
  }
}

// 管理员撤回任意用户消息
async function recallAnyMessage(targetUserId, timestamp) {
  try {
    await api('recall-message', 'POST', { targetUserId, timestamp });
    showToast('已撤回该消息');
  } catch (err) {
    showToast('操作失败: ' + err.message);
  }
}

// ====================== 通用模态框 ======================
function openGenericModal(html) {
  $('genericModalCard').innerHTML = html;
  $('genericModal').classList.remove('hidden');
}
function closeGenericModal() {
  $('genericModal').classList.add('hidden');
}

// ====================== WebRTC 通话（完整保留原有实现）======================

async function startCall(type) {
  if (!selectedContact) return;

  callType = type;
  isCallInitiator = true;

  try {
    // 获取本地媒体流 - 1080p 高清
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: type === 'video' ? videoConstraints1080p : false
    });

    // 创建 PeerConnection
    createPeerConnection();

    // 添加本地轨道
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // 显示通话界面
    showCallScreen(type, selectedContact.name, true);

    // 发送通话请求
    sendWS({
      type: 'call-request',
      to: selectedContact.id,
      callType: type
    });

    $('callStatusText').textContent = '正在呼叫...';

    // 创建 Offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    sendWS({
      type: 'webrtc-offer',
      to: selectedContact.id,
      sdp: offer
    });

  } catch (err) {
    console.error('获取媒体设备失败:', err);
    showToast('无法访问摄像头/麦克风，请检查权限设置');
    cleanupCall();
  }
}

function handleIncomingCall(msg) {
  pendingCallFrom = msg.from;
  pendingCallType = msg.callType;

  // 查找来电者信息
  const caller = onlineUsers.find(u => u.id === msg.from);
  const callerName = caller ? caller.name : '未知用户';

  $('incomingName').textContent = callerName;
  $('incomingType').textContent = msg.callType === 'video' ? '视频通话' : '语音通话';
  $('incomingAvatar').textContent = getInitial(callerName);
  $('incomingAvatar').style.background = getAvatarColor(callerName);

  $('incomingCallModal').classList.remove('hidden');
}

async function acceptCall() {
  $('incomingCallModal').classList.add('hidden');

  callType = pendingCallType;
  isCallInitiator = false;

  // 查找来电者
  const caller = onlineUsers.find(u => u.id === pendingCallFrom);
  const callerName = caller ? caller.name : '用户';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: pendingCallType === 'video' ? videoConstraints1080p : false
    });

    createPeerConnection();
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    showCallScreen(pendingCallType, callerName, false);
    $('callStatusText').textContent = '正在连接...';

    // 接受通话
    sendWS({
      type: 'call-accepted',
      to: pendingCallFrom,
      callType: pendingCallType
    });

  } catch (err) {
    console.error('获取媒体设备失败:', err);
    showToast('无法访问摄像头/麦克风');
    sendWS({ type: 'call-rejected', to: pendingCallFrom });
    cleanupCall();
  }
}

function rejectCall() {
  $('incomingCallModal').classList.add('hidden');
  sendWS({ type: 'call-rejected', to: pendingCallFrom });
  pendingCallFrom = null;
  pendingCallType = null;
}

async function handleCallAccepted(msg) {
  $('callStatusText').textContent = '已连接';
  startCallTimer();
  isInCall = true;
}

function handleCallRejected() {
  showToast('对方拒绝了通话');
  cleanupCall();
}

async function handleWebRTCOffer(msg) {
  if (!peerConnection) {
    // 作为被叫方，PeerConnection 在 acceptCall 时已创建
    // 如果还没创建，在这里创建
    if (!localStream) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: pendingCallType === 'video' ? videoConstraints1080p : false
        });
        createPeerConnection();
        localStream.getTracks().forEach(track => {
          peerConnection.addTrack(track, localStream);
        });
      } catch (err) {
        console.error('获取媒体失败:', err);
        sendWS({ type: 'call-rejected', to: msg.from });
        return;
      }
    }
  }

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));

    // 发送缓冲的 ICE candidates
    if (iceCandidatesBuffer.length > 0) {
      for (const candidate of iceCandidatesBuffer) {
        await peerConnection.addIceCandidate(candidate);
      }
      iceCandidatesBuffer = [];
    }

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    sendWS({
      type: 'webrtc-answer',
      to: msg.from,
      sdp: answer
    });

  } catch (err) {
    console.error('处理 Offer 失败:', err);
  }
}

async function handleWebRTCAnswer(msg) {
  if (peerConnection) {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      $('callStatusText').textContent = '已连接';
      startCallTimer();
      isInCall = true;
    } catch (err) {
      console.error('设置远端描述失败:', err);
    }
  }
}

async function handleICECandidate(msg) {
  if (peerConnection && peerConnection.remoteDescription) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
      console.error('添加 ICE candidate 失败:', err);
    }
  } else {
    iceCandidatesBuffer.push(new RTCIceCandidate(msg.candidate));
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  // 设置接收偏好 - 优先高清
  if (typeof RTCReceiver !== 'undefined' && rtcReceiverPrefs) {
    try {
      for (const pref of rtcReceiverPrefs) {
        const receiver = peerConnection.addTransceiver(pref.kind);
        receiver.setCodecPreferences && receiver.setCodecPreferences([]);
      }
    } catch (e) {
      console.log('接收器偏好设置跳过:', e);
    }
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendWS({
        type: 'webrtc-ice-candidate',
        to: isCallInitiator ? (selectedContact ? selectedContact.id : null) : pendingCallFrom,
        candidate: event.candidate
      });
    }
  };

  peerConnection.ontrack = (event) => {
    remoteStream = event.streams[0];
    const remoteVideo = $('remoteVideo');
    remoteVideo.srcObject = remoteStream;
    // 强制高清播放
    remoteVideo.style.width = '100%';
    remoteVideo.style.height = '100%';
    remoteVideo.style.objectFit = 'cover';
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;
    console.log('连接状态:', state);
    if (state === 'connected') {
      $('callStatusText').textContent = '已连接';
      if (!callTimerInterval) startCallTimer();
      // 连接建立后提升编码器码率
      applyHighQualityEncoding();
    } else if (state === 'disconnected' || state === 'failed') {
      showToast('通话连接中断');
      endCall();
    }
  };
}

// 连接建立后提升编码器参数到 1080p
function applyHighQualityEncoding() {
  if (!peerConnection) return;

  const senders = peerConnection.getSenders();
  for (const sender of senders) {
    if (sender.track && sender.track.kind === 'video') {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      // 设置 1080p 高清编码参数
      params.encodings[0].maxBitrate = 4_000_000;        // 4 Mbps
      params.encodings[0].maxFramerate = 30;
      params.encodings[0].scaleResolutionDownBy = 1;     // 不缩放
      // 优先级设为高
      params.priority = 'high';
      params.degradationPreference = 'maintain-resolution'; // 网络差时优先保持分辨率
      sender.setParameters(params).catch(e => {
        console.log('设置编码参数失败:', e);
      });
      console.log('已应用 1080p 高清编码参数');
    }
    if (sender.track && sender.track.kind === 'audio') {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = 128_000; // 128 kbps 音频
      params.priority = 'high';
      sender.setParameters(params).catch(() => {});
    }
  }
}

function showCallScreen(type, name, isInitiator) {
  $('callScreen').classList.remove('hidden');

  if (type === 'video') {
    $('callVideos')?.classList.remove('hidden');
    $('audioCallView').classList.add('hidden');
    $('remoteVideo').classList.remove('hidden');
    $('localVideo').classList.remove('hidden');
    $('localVideo').srcObject = localStream;
    $('videoToggleBtn').style.display = 'flex';
  } else {
    $('audioCallView').classList.remove('hidden');
    $('callVideos')?.classList.add('hidden');
    $('remoteVideo').classList.add('hidden');
    $('localVideo').classList.add('hidden');
    $('videoToggleBtn').style.display = 'none';
  }

  $('callName').textContent = name;
  $('callAvatar').textContent = getInitial(name);
  $('callAvatar').style.background = getAvatarColor(name);
  $('callTimer').textContent = '00:00';
}

function startCallTimer() {
  callStartTime = Date.now();
  callTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    $('callTimer').textContent = formatDuration(elapsed);
  }, 1000);
}

function endCall() {
  if (selectedContact || pendingCallFrom) {
    const targetId = isCallInitiator ? (selectedContact ? selectedContact.id : null) : pendingCallFrom;
    if (targetId) {
      sendWS({ type: 'call-ended', to: targetId });
    }
  }
  handleCallEnded();
}

function handleCallEnded() {
  cleanupCall();
}

function cleanupCall() {
  isInCall = false;
  isCallInitiator = false;
  isMuted = false;
  isVideoOff = false;

  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }

  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  remoteStream = null;
  iceCandidatesBuffer = [];

  $('remoteVideo').srcObject = null;
  $('localVideo').srcObject = null;
  $('callScreen').classList.add('hidden');

  pendingCallFrom = null;
  pendingCallType = null;

  // 重置按钮状态
  $('muteBtn').classList.remove('active');
  $('videoToggleBtn').classList.remove('active');
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $('muteBtn').classList.toggle('active', isMuted);
}

function toggleVideo() {
  if (!localStream || callType !== 'video') return;
  isVideoOff = !isVideoOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isVideoOff);
  $('videoToggleBtn').classList.toggle('active', isVideoOff);
  $('localVideo').classList.toggle('hidden', isVideoOff);
}

// ====================== 表情面板 ======================
const EMOJIS = ['😀','😁','😂','🤣','😃','😄','😅','😆','😉','😊','😋','😎','😍','😘','🥰','🙂','🤗','🤔','😐','😑','😶','🙄','😏','😣','😥','😮','🤐','😯','😪','😫','😴','😌','😛','😜','😝','🤤','😒','😓','😔','😕','🙃','🫠','🤑','🥳','🥺','🤓','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😓','🤝','👍','👎','👏','🙏','💪','❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','💯','✅','❌','⭐','🔥','🎉','🎁','💬','📷','🎥','🎵'];

function buildEmojiPanel() {
  const grid = $('emojiGrid');
  if (!grid) return;
  grid.innerHTML = EMOJIS.map(e => `<span onclick="insertEmoji('${e}')">${e}</span>`).join('');
}

function insertEmoji(emoji) {
  const input = $('messageInput');
  input.value += emoji;
  input.focus();
  updateSendVsMic();
}

// ====================== Logo / 设置 长按隐藏入口 ======================
let logoTapCount = 0;
let logoTapTimer = null;
function onLogoTap() {
  logoTapCount++;
  clearTimeout(logoTapTimer);
  logoTapTimer = setTimeout(() => { logoTapCount = 0; }, 1500);
  if (logoTapCount >= 5) {
    logoTapCount = 0;
    showAdminLoginForm();
    showToast('管理员登录入口已开启');
  }
}

let settingsTapCount = 0;
let settingsTapTimer = null;
function onSettingsTabLongPress() {
  settingsTapCount++;
  clearTimeout(settingsTapTimer);
  settingsTapTimer = setTimeout(() => { settingsTapCount = 0; }, 2000);
  if (settingsTapCount >= 5) {
    settingsTapCount = 0;
    if (myRole === 'admin') {
      showAdminPanel();
    } else {
      showToast('非管理员账号');
    }
  }
}

// ====================== 事件绑定 ======================
function bindEvents() {
  // ===== 登录 / 注册 =====
  $('loginBtn').addEventListener('click', handleLogin);
  $('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLogin(); });

  $('registerBtn').addEventListener('click', handleRegister);
  $('registerPasswordConfirm').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleRegister(); });

  $('switchToRegisterBtn').addEventListener('click', showRegisterForm);
  $('switchToLoginBtn').addEventListener('click', showLoginForm);

  // 管理员登录
  $('adminLoginBtn').addEventListener('click', handleAdminLogin);
  $('adminLoginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleAdminLogin(); });
  $('adminLoginBackBtn').addEventListener('click', showLoginForm);
  // Logo 连点 5 次显示管理员登录
  $('loginLogo').addEventListener('click', onLogoTap);

  // ===== Tab 导航（桌面左侧 + 移动底部）=====
  document.querySelectorAll('[data-tab]').forEach(el => {
    el.addEventListener('click', () => switchTab(el.dataset.tab));
  });
  // 设置 Tab 长按隐藏入口
  $('settingsTabBtn').addEventListener('click', onSettingsTabLongPress);

  // ===== 退出登录 =====
  $('logoutBtn').addEventListener('click', handleLogout);
  $('settingsLogoutBtn').addEventListener('click', handleLogout);
  $('settingsSwitchAccountBtn').addEventListener('click', handleSwitchAccount);
  $('settingsClearChatBtn').addEventListener('click', handleClearChat);
  $('settingsAdminBtn').addEventListener('click', showAdminPanel);

  // ===== 数据导出/导入 =====
  $('exportDataBtn').addEventListener('click', exportUserData);
  $('importDataBtn').addEventListener('click', () => $('importFileInput').click());
  $('importFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importUserData(file);
    e.target.value = ''; // 重置以便重复导入同一文件
  });

  // ===== 检查更新 =====
  $('checkUpdateBtn').addEventListener('click', checkForUpdates);
  // 显示服务器地址和当前版本
  $('serverUrlDisplay').textContent = SERVER_URL.replace(/^https?:\/\//, '');
  var versionEl = $('appVersionDisplay');
  if (versionEl) versionEl.textContent = APP_VERSION;

  // ===== 管理员面板 =====
  $('adminEnterChatBtn').addEventListener('click', enterChat);
  $('adminLogoutBtn').addEventListener('click', handleLogout);
  document.querySelectorAll('.admin-tab-btn').forEach(b => {
    b.addEventListener('click', () => switchAdminTab(b.dataset.adminTab));
  });

  // ===== 聊天功能 =====
  $('searchInput').addEventListener('input', renderConversations);

  // 发送文字
  $('sendBtn').addEventListener('click', () => {
    const text = $('messageInput').value.trim();
    if (text && (selectedContact || selectedGroup)) {
      sendMessage(text, 'text');
      $('messageInput').value = '';
      updateSendVsMic();
    }
  });

  $('messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('sendBtn').click();
    }
  });
  $('messageInput').addEventListener('input', updateSendVsMic);

  // 表情
  $('emojiBtn').addEventListener('click', () => $('emojiPanel').classList.toggle('show'));
  // 点击空白关闭表情面板
  document.addEventListener('click', (e) => {
    if (!$('emojiPanel').contains(e.target) && e.target.id !== 'emojiBtn' && !$('emojiBtn').contains(e.target)) {
      $('emojiPanel').classList.remove('show');
    }
  });

  // 发送图片
  $('imageBtn').addEventListener('click', () => $('imageFileInput').click());
  $('imageFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFileSelect(file, 'image');
    e.target.value = '';
  });

  // 发送视频
  $('videoSendBtn').addEventListener('click', () => $('videoFileInput').click());
  $('videoFileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFileSelect(file, 'video');
    e.target.value = '';
  });

  // 发送文件
  $('fileBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFileSelect(file, 'file');
    e.target.value = '';
  });

  // 语音录制（TG 风格：点击开始/停止）
  $('voiceRecordBtn').addEventListener('click', () => {
    if ($('voiceRecordBtn').classList.contains('recording')) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  // 语音 / 视频通话
  $('voiceCallBtn').addEventListener('click', () => {
    if (selectedContact && !isInCall) startCall('audio');
  });
  $('videoCallBtn').addEventListener('click', () => {
    if (selectedContact && !isInCall) startCall('video');
  });

  // 通话控制
  $('muteBtn').addEventListener('click', toggleMute);
  $('videoToggleBtn').addEventListener('click', toggleVideo);
  $('hangupBtn').addEventListener('click', endCall);

  // 来电弹窗
  $('acceptCallBtn').addEventListener('click', acceptCall);
  $('rejectCallBtn').addEventListener('click', rejectCall);

  // 移动端返回按钮
  $('backBtn').addEventListener('click', showContactsOnMobile);

  // 创建群聊
  $('createGroupBtn').addEventListener('click', openCreateGroupModal);

  // ===== 通讯录 =====
  $('addFriendBtn').addEventListener('click', openAddFriendModal);

  // ===== 社区 =====
  $('createChannelBtn').addEventListener('click', openCreateChannelModal);
  $('postSendBtn').addEventListener('click', createPost);
  $('postInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') createPost(); });
  $('postImageBtn').addEventListener('click', () => $('postImageInput').click());
  $('postImageInput').addEventListener('change', onPostImageSelect);
  $('channelInviteBtn').addEventListener('click', generateChannelInviteLink);
  $('channelBackBtn').addEventListener('click', backToChannelList);

  // ===== 文件传输 =====
  $('uploadZone').addEventListener('click', () => $('transferFileInput').click());
  $('transferFileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) uploadTransferFile(e.target.files[0]);
  });
  // 拖拽上传
  const uploadZone = $('uploadZone');
  uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) uploadTransferFile(e.dataTransfer.files[0]);
  });
  $('copyCodeBtn').addEventListener('click', copyTransferCode);
  $('queryCodeBtn').addEventListener('click', queryTransferCode);
  $('downloadCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') queryTransferCode(); });
  $('downloadFileBtn').addEventListener('click', downloadTransferFile);

  // ===== 设置：主题与颜色 =====
  document.querySelectorAll('.theme-card').forEach(card => {
    card.addEventListener('click', () => switchTheme(card.dataset.theme));
  });

  // 颜色选择器联动 + 实时预览
  bindColorPicker('colorBubble', 'colorBubbleHex', 'bubble');
  bindColorPicker('colorSidebar', 'colorSidebarHex', 'sidebar');
  bindColorPicker('colorButton', 'colorButtonHex', 'button');
  $('saveColorsBtn').addEventListener('click', saveCustomColors);
  $('resetColorsBtn').addEventListener('click', resetCustomColors);

  // ===== 消息上下文菜单 =====
  $('messageContextMenu').querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => handleContextAction(btn.dataset.action));
  });
  // 点击空白关闭菜单
  document.addEventListener('click', (e) => {
    const menu = $('messageContextMenu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) {
      hideMessageContextMenu();
    }
  });
  document.addEventListener('scroll', hideMessageContextMenu, true);

  // 通用模态框：点击遮罩关闭
  $('genericModal').addEventListener('click', (e) => {
    if (e.target.id === 'genericModal') closeGenericModal();
  });

  // 窗口关闭时清理
  window.addEventListener('beforeunload', () => {
    if (isInCall) endCall();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    if (ws) ws.close();
  });
}

// 绑定颜色选择器（color 与 hex 输入双向同步 + 实时预览）
function bindColorPicker(colorId, hexId, type) {
  const colorEl = $(colorId);
  const hexEl = $(hexId);
  colorEl.addEventListener('input', () => {
    hexEl.value = colorEl.value;
    updateCustomColor(type, colorEl.value);
  });
  hexEl.addEventListener('input', () => {
    let v = hexEl.value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
      if (!v.startsWith('#')) v = '#' + v;
      colorEl.value = v;
      updateCustomColor(type, v);
    }
  });
}

// ====================== 初始化 ======================
function init() {
  buildEmojiPanel();
  bindEvents();
  loadTheme();      // 先应用本地主题，避免登录页闪烁
  checkSession();
  registerServiceWorker(); // 注册 PWA Service Worker
}

// ====================== PWA Service Worker ======================
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => {
        console.log('Service Worker 已注册', reg.scope);
        // 检测到新版本时自动更新
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
                // 新版本已激活，提示用户刷新
                showToast('应用已更新，刷新以加载最新版本');
              }
            });
          }
        });
      })
      .catch((err) => console.error('Service Worker 注册失败:', err));
  }
}

init();
