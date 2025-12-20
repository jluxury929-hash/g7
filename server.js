// ===============================================================================
// APEX UNIFIED MASTER v12.9.0 (NITRO-PROFIT + BIG-FISH EVOLUTION)
// ===============================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const WebSocket = require('ws'); // Added for Raw WebSocket Speed

const app = express();
app.use(cors());
app.use(express.json());

// 1. CONFIGURATION
const PORT = process.env.PORT || 8080;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
const CONTRACT_ADDR = "0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0";
const SCANNER_BASE = "https://basescan.org/tx/";

// --- NITRO PROFIT MATH ---
const MIN_WHALE_SIZE = "1.0";       // MATH FIX: Only strike > 1.0 ETH for slippage gap
const CRITICAL_GAS_LIMIT = "0.001"; // STOP firing if wallet drops below this
const BASE_FLASH_LOAN = "250";      // Starting attack size
const MAX_FLASH_LOAN = "1200";      // Max ceiling for mega-whales
// ----------------------------

const RPC_POOL = [
    process.env.QUICKNODE_HTTP,
    "https://mainnet.base.org",
    "https://base.llamarpc.com"
].filter(url => url).map(u => u.trim().replace(/['"]+/g, ''));

const WSS_URL = (process.env.QUICKNODE_WSS || "wss://base-rpc.publicnode.com").trim().replace(/['"]+/g, '');

const TOKENS = { 
    WETH: "0x4200000000000000000000000000000000000006", 
    DEGEN: "0x4edbc9ba171790664872997239bc7a3f3a633190" 
};

const ABI = [
    "function executeFlashArbitrage(address tokenA, address tokenOut, uint256 amount) external",
    "function withdraw() external",
    "function balanceOf(address account) external view returns (uint256)"
];

let provider, signer, flashContract, transactionNonce, currentGasBalance;

// 2. STABILIZED BOOT (FIXED BATCH LIMITS + FAILOVER)
async function init() {
    console.log("-----------------------------------------");
    console.log("🚀 APEX v12.9.0: NITRO-PROFIT ONLINE");
    const network = ethers.Network.from(8453); 

    try {
        const configs = RPC_POOL.map((url, i) => ({
            provider: new ethers.JsonRpcProvider(url, network, { 
                staticNetwork: true,
                batchMaxCount: 1 
            }),
            priority: i === 0 ? 1 : 2,
            stallTimeout: 2500
        }));

        provider = new ethers.FallbackProvider(configs, network, { quorum: 1 });
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        flashContract = new ethers.Contract(CONTRACT_ADDR, ABI, signer);
        
        currentGasBalance = await provider.getBalance(signer.address);
        transactionNonce = await provider.getTransactionCount(signer.address, 'pending');

        console.log(`✅ [CONNECTED] Block: Synced`);
        console.log(`[WALLET] Gas: ${ethers.formatEther(currentGasBalance).substring(0, 7)} ETH`);
        console.log(`🎯 [TARGET] Whale: >1.0 ETH | Dynamic Loan: 250-1200 WETH`);
        console.log("-----------------------------------------");
    } catch (e) {
        console.error(`❌ [BOOT ERROR] ${e.message}`);
        setTimeout(init, 5000);
    }
}

// 3. NITRO STRIKE ENGINE (DYNAMIC ATTACK + SPEED)
async function executeApexStrike(txHash) {
    try {
        // Fetch full tx details from hash provided by WebSocket
        const targetTx = await provider.getTransaction(txHash);
        
        // A. PROFIT FILTER: Only swing at > 1.0 ETH whales
        if (!targetTx || !targetTx.value || targetTx.value < ethers.parseEther(MIN_WHALE_SIZE)) return;
        if (currentGasBalance < ethers.parseEther(CRITICAL_GAS_LIMIT)) return;

        const startTime = Date.now();
        const whaleVal = parseFloat(ethers.formatEther(targetTx.value));
        
        // B. MATH FIX: Scale attack based on whale size (Bigger whale = Bigger loan)
        let loanAmount = BASE_FLASH_LOAN; 
        if (whaleVal > 3.0) loanAmount = "600"; 
        if (whaleVal > 10.0) loanAmount = MAX_FLASH_LOAN;

        // C. NITRO SPEED: High-Priority Gas Bid (Dec 2025 Standard)
        flashContract.executeFlashArbitrage(
            TOKENS.WETH, 
            TOKENS.DEGEN, 
            ethers.parseEther(loanAmount.toString()), 
            {
                gasLimit: 850000,
                maxPriorityFeePerGas: ethers.parseUnits("0.25", "gwei"), 
                maxFeePerGas: ethers.parseUnits("0.50", "gwei"),
                nonce: transactionNonce++,
                type: 2
            }
        ).then(tx => {
            const latency = Date.now() - startTime;
            console.log(`\n💰 [STRIKE SENT] Whale: ${whaleVal.toFixed(2)} ETH | Attack: ${loanAmount} WETH | Latency: ${latency}ms`);
            console.log(`🔗 [VIEW TX] ${SCANNER_BASE}${tx.hash}`);

            tx.wait(1).then(receipt => {
                if (receipt.status === 1) {
                    console.log(`✅ [SUCCESS] Won the block. Check WETH balance.`);
                } else {
                    console.log(`⚠️  [REVERT] No profit gap or competition beat us.`);
                }
            }).catch(() => {});

        }).catch(err => {
            if (err.message.includes("nonce")) {
                provider.getTransactionCount(signer.address, 'pending').then(n => transactionNonce = n);
            }
        });
    } catch (e) {}
}

// 4. NITRO SNIFFER (RAW WEBSOCKET SPEED)
function startNitroScanner() {
    console.log(`🔍 SNIFFER LIVE: RAW WEBSOCKET MODE`);
    
    // Connects via raw WebSocket for lower latency than the ethers wrapper
    const ws = new WebSocket(WSS_URL);
    const wethContract = new ethers.Contract(TOKENS.WETH, ABI, provider);

    ws.on('open', () => {
        ws.send(JSON.stringify({ 
            "jsonrpc": "2.0", 
            "id": 1, 
            "method": "eth_subscribe", 
            "params": ["newPendingTransactions"] 
        }));
    });

    ws.on('message', (data) => {
        const response = JSON.parse(data);
        if (response.params && response.params.result) {
            // response.params.result is the transaction hash
            executeApexStrike(response.params.result);
        }
    });

    // Heartbeat every 45 seconds
    setInterval(async () => {
        try {
            currentGasBalance = await provider.getBalance(signer.address);
            const wethBal = await wethContract.balanceOf(CONTRACT_ADDR).catch(() => 0n);
            console.log(`[HB] Gas: ${ethers.formatEther(currentGasBalance).substring(0,6)} | Earned (WETH): ${ethers.formatEther(wethBal).substring(0,7)} | Nonce: ${transactionNonce}`);
        } catch (e) {}
    }, 45000);

    ws.on("close", () => {
        console.log("🔄 Reconnecting Nitro Sniffer...");
        setTimeout(startNitroScanner, 2000);
    });
}

// 5. WITHDRAWAL & STATUS
app.post(`/withdraw/standard-eoa`, async (req, res) => {
    try {
        const tx = await flashContract.withdraw({ nonce: transactionNonce++ });
        await tx.wait();
        res.json({ success: true, hash: tx.hash });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/status', async (req, res) => {
    try {
        const bal = await provider.getBalance(signer.address);
        const wethContract = new ethers.Contract(TOKENS.WETH, ABI, provider);
        const wethBal = await wethContract.balanceOf(CONTRACT_ADDR);
        res.json({ 
            status: "NITRO_HUNTING", 
            gas_eth: ethers.formatEther(bal), 
            contract_weth: ethers.formatEther(wethBal) 
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

init().then(() => {
    app.listen(PORT, () => startNitroScanner());
});
