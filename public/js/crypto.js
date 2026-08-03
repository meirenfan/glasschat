// ===== 全局服务器地址配置 =====
// Capacitor APK 运行在 localhost，必须使用绝对地址才能连接远程后端
const SERVER_URL = 'https://glasschat-production.up.railway.app';

/** 将相对 URL 转为绝对 URL（Capacitor 环境必须） */
function absUrl(u) {
  if (!u) return u;
  if (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('wss://') || u.startsWith('ws://')) return u;
  if (u.startsWith('/')) return SERVER_URL + u;
  return SERVER_URL + '/' + u;
}

// ===== 端到端加密模块 =====
// 使用 ECDH (P-256) 密钥交换 + AES-GCM 加密
// 密钥对持久化到 localStorage，跨会话复用同一密钥对，
// 确保刷新页面/二次登录后仍能解密历史消息。

let myKeyPair = null;
let myPublicKeyBase64 = null;
const sharedSecrets = {}; // { userId: CryptoKey }

// ===== 密钥对持久化（JWK 格式存入 localStorage）=====

/**
 * 将密钥对导出为 JWK 并保存到 localStorage
 */
async function saveKeyPair() {
  if (!myKeyPair) return;
  try {
    const privateJwk = await crypto.subtle.exportKey('jwk', myKeyPair.privateKey);
    const publicJwk = await crypto.subtle.exportKey('jwk', myKeyPair.publicKey);
    localStorage.setItem('gc_ecdh_private', JSON.stringify(privateJwk));
    localStorage.setItem('gc_ecdh_public', JSON.stringify(publicJwk));
  } catch (err) {
    console.error('保存密钥对失败:', err);
  }
}

/**
 * 从 localStorage 加载已保存的密钥对
 * @returns {boolean} 是否成功加载
 */
async function loadKeyPair() {
  try {
    const privateJwkStr = localStorage.getItem('gc_ecdh_private');
    const publicJwkStr = localStorage.getItem('gc_ecdh_public');
    if (!privateJwkStr || !publicJwkStr) return false;

    const privateJwk = JSON.parse(privateJwkStr);
    const publicJwk = JSON.parse(publicJwkStr);

    const privateKey = await crypto.subtle.importKey(
      'jwk', privateJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true, ['deriveKey']
    );
    const publicKey = await crypto.subtle.importKey(
      'jwk', publicJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true, []
    );

    myKeyPair = { privateKey, publicKey };
    const exported = await crypto.subtle.exportKey('raw', publicKey);
    myPublicKeyBase64 = arrayBufferToBase64(exported);
    return true;
  } catch (err) {
    console.error('加载密钥对失败:', err);
    return false;
  }
}

/**
 * 清除已保存的密钥对（切换账号时调用）
 */
function clearKeyPair() {
  localStorage.removeItem('gc_ecdh_private');
  localStorage.removeItem('gc_ecdh_public');
  clearSharedSecrets();
  myKeyPair = null;
  myPublicKeyBase64 = null;
  // 清除所有共享密钥
  Object.keys(sharedSecrets).forEach(k => delete sharedSecrets[k]);
}

// ===== Base64 工具 =====
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ===== 生成 ECDH 密钥对（优先从 localStorage 加载，避免刷新后密钥变更）=====
async function generateKeyPair() {
  // 1. 尝试加载已保存的密钥对
  const loaded = await loadKeyPair();
  if (loaded) {
    console.log('已加载持久化密钥对');
    // 加载已保存的共享密钥（确保离线消息也能解密）
    await loadSharedSecrets();
    return myPublicKeyBase64;
  }

  // 2. 没有保存的密钥对，生成新的并保存
  myKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
  const exported = await crypto.subtle.exportKey('raw', myKeyPair.publicKey);
  myPublicKeyBase64 = arrayBufferToBase64(exported);
  await saveKeyPair();
  console.log('已生成并保存新密钥对');
  return myPublicKeyBase64;
}

// ===== 从 Base64 导入对方公钥 =====
async function importPublicKey(base64) {
  const buffer = base64ToArrayBuffer(base64);
  return await crypto.subtle.importKey(
    'raw',
    buffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

// ===== 派生共享密钥（可导出，持久化到 localStorage）=====
async function deriveSharedSecret(otherPublicKeyBase64, userId) {
  const otherPublicKey = await importPublicKey(otherPublicKeyBase64);
  const sharedSecret = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: otherPublicKey },
    myKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    true, // 可导出，用于持久化
    ['encrypt', 'decrypt']
  );
  sharedSecrets[userId] = sharedSecret;
  await saveSharedSecret(userId, sharedSecret);
  return sharedSecret;
}

// ===== 共享密钥持久化 =====

/** 保存单个共享密钥到 localStorage */
async function saveSharedSecret(userId, key) {
  try {
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const all = JSON.parse(localStorage.getItem('gc_shared_secrets') || '{}');
    all[userId] = jwk;
    localStorage.setItem('gc_shared_secrets', JSON.stringify(all));
  } catch (err) {
    console.error('保存共享密钥失败:', err);
  }
}

/** 从 localStorage 加载所有共享密钥 */
async function loadSharedSecrets() {
  try {
    const raw = localStorage.getItem('gc_shared_secrets');
    if (!raw) return;
    const all = JSON.parse(raw);
    for (const [userId, jwk] of Object.entries(all)) {
      if (!sharedSecrets[userId]) {
        const key = await crypto.subtle.importKey(
          'jwk', jwk,
          { name: 'AES-GCM', length: 256 },
          true, ['encrypt', 'decrypt']
        );
        sharedSecrets[userId] = key;
      }
    }
    console.log(`已加载 ${Object.keys(all).length} 个持久化共享密钥`);
  } catch (err) {
    console.error('加载共享密钥失败:', err);
  }
}

/** 清除所有共享密钥（切换账号时调用）*/
function clearSharedSecrets() {
  localStorage.removeItem('gc_shared_secrets');
}

// ===== 加密文本 =====
async function encryptText(plaintext, userId) {
  const key = sharedSecrets[userId];
  if (!key) throw new Error('未建立加密通道');

  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  // 返回 iv + 密文，Base64 编码
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return 'enc:' + arrayBufferToBase64(combined.buffer);
}

// ===== 解密文本 =====
async function decryptText(ciphertextStr, userId) {
  // 如果不是加密消息，直接返回原文（兼容旧消息）
  if (!ciphertextStr || !ciphertextStr.startsWith('enc:')) {
    return ciphertextStr;
  }

  const key = sharedSecrets[userId];
  if (!key) {
    return '[消息需要建立加密通道才能查看]';
  }

  try {
    const base64 = ciphertextStr.slice(4); // 去掉 'enc:'
    const combined = new Uint8Array(base64ToArrayBuffer(base64));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (err) {
    console.error('解密失败:', err);
    return '[解密失败]';
  }
}

// ===== 加密文件 =====
async function encryptFile(fileArrayBuffer, userId) {
  const key = sharedSecrets[userId];
  if (!key) throw new Error('未建立加密通道');

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    fileArrayBuffer
  );

  // 返回 iv + 密文
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return combined.buffer;
}

// ===== 解密文件 =====
async function decryptFile(encryptedArrayBuffer, userId) {
  const key = sharedSecrets[userId];
  if (!key) throw new Error('未建立加密通道');

  const combined = new Uint8Array(encryptedArrayBuffer);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return decrypted;
}

// ===== 获取已加密的文件 URL =====
// 加密文件通过 blob URL 在本地解密后展示
async function fetchAndDecryptFile(url, userId) {
  const response = await fetch(absUrl(url));
  const encryptedBuffer = await response.arrayBuffer();
  const decryptedBuffer = await decryptFile(encryptedBuffer, userId);
  return URL.createObjectURL(new Blob([decryptedBuffer]));
}
