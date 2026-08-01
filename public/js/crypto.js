// ===== 端到端加密模块 =====
// 使用 ECDH (P-256) 密钥交换 + AES-GCM 加密

let myKeyPair = null;
let myPublicKeyBase64 = null;
const sharedSecrets = {}; // { userId: CryptoKey }

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

// ===== 生成 ECDH 密钥对 =====
async function generateKeyPair() {
  myKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey']
  );
  const exported = await crypto.subtle.exportKey('raw', myKeyPair.publicKey);
  myPublicKeyBase64 = arrayBufferToBase64(exported);
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

// ===== 派生共享密钥 =====
async function deriveSharedSecret(otherPublicKeyBase64, userId) {
  const otherPublicKey = await importPublicKey(otherPublicKeyBase64);
  const sharedSecret = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: otherPublicKey },
    myKeyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  sharedSecrets[userId] = sharedSecret;
  return sharedSecret;
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
  const response = await fetch(url);
  const encryptedBuffer = await response.arrayBuffer();
  const decryptedBuffer = await decryptFile(encryptedBuffer, userId);
  return URL.createObjectURL(new Blob([decryptedBuffer]));
}
