// ===============================================================================
// APEX UNIFIED MASTER v12.8.6 (BIG-FISH EDITION: NITRO SPEED + WETH TRACKING)
// ===============================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// 1. CONFIGURATION
const PORT = process.env.PORT || 8080;
const PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY;
const CONTRACT_ADDR = "0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0"; // Your Smart Contract
const SCANNER_BASE = "https://basescan.org/tx/";

// --- NITRO PROFIT SLIDERS ---
const MIN_WHALE_SIZE = "0.5";       // Only strike if whale trade is > 0.5 ETH
const CRITICAL_GAS_LIMIT = "0.001"; // STOP firing if wallet drops below 0.001 ETH
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

// ABI updated to include balanceOf for WETH monitoring
const ABI = [
    "function executeFlashArbitrage(address tokenA, address tokenOut, uint256 amount) external",
    "function getContractBalance() external view returns (uint256)",
    "function withdraw() external",
    "function balanceOf(address account) external view returns (uint256)"
];

let provider, signer, flashContract, transactionNonce, currentGasBalance;

// 2. STABILIZED BOOT (FIXED BATCH LIMITS)
async function init() {
    console.log("-----------------------------------------");
    console.log("🐋 APEX v12.8.6: BIG-FISH + WETH MONITOR");
    const network = ethers.Network.from(8453); // Base Mainnet

    try {
        const configs = RPC_POOL.map((url, i) => ({
            // batchMaxCount: 1 fixes the "maximum 10 calls in 1 batch" error
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
        console.log(`🎯 [TARGET] Min Whale: ${MIN_WHALE_SIZE} ETH`);
        console.log("-----------------------------------------");
    } catch (e) {
        console.error(`❌ [BOOT ERROR] ${e.message}`);
        setTimeout(init, 5000);
    }
}

// 3. NITRO STRIKE ENGINE (OPTIMIZED GAS)
function executeApexStrike(targetTx) {
    // A. WHALE FILTER: Only swing at real opportunities
    if (!targetTx || !targetTx.value || targetTx.value < ethers.parseEther(MIN_WHALE_SIZE)) return;

    // B. GAS SAFEGUARD: Protect your remaining gas
    if (currentGasBalance < ethers.parseEther(CRITICAL_GAS_LIMIT)) {
        console.log("🛑 [SYSTEM PAUSED] Gas below critical limit. Refill required.");
        return;
    }

    const startTime = Date.now();
    const whaleVal = ethers.formatEther(targetTx.value).substring(0, 6);

    // FIRE-AND-FORGET
    flashContract.executeFlashArbitrage(
        TOKENS.WETH, 
        TOKENS.DEGEN, 
        ethers.parseEther("100"), 
        {
            gasLimit: 750000, 
            maxPriorityFeePerGas: ethers.parseUnits("0.1", "gwei"),
            maxFeePerGas: ethers.parseUnits("0.2", "gwei"),
            nonce: transactionNonce++,
            type: 2
        }
    ).then(tx => {
        const latency = Date.now() - startTime;
        console.log(`\n🚀 [BIG FISH STRIKE] Whale: ${whaleVal} ETH | Latency: ${latency}ms`);
        console.log(`🔗 [VIEW TX] ${SCANNER_BASE}${tx.hash}`);

        tx.wait(1).then(receipt => {
            if (receipt.status === 1) {
                console.log(`✅ [SUCCESS] Tx mined in block ${receipt.blockNumber}`);
            } else {
                console.log(`⚠️  [REVERT] Competition won the race / No profit found.`);
            }
        }).catch(() => {});

    }).catch(err => {
        if (err.message.includes("nonce")) {
            provider.getTransactionCount(signer.address, 'pending').then(n => transactionNonce = n);
        }
    });
}

// 4. SCANNER & PROFIT MONITOR
function startScanning() {
    console.log(`🔍 SNIFFER LIVE: ${WSS_URL.substring(0, 30)}...`);
    const wssProvider = new ethers.WebSocketProvider(WSS_URL);
    const wethContract = new ethers.Contract(TOKENS.WETH, ABI, provider);
    
    wssProvider.on("pending", (h) => {
        provider.getTransaction(h).then(tx => {
            if (tx) executeApexStrike(tx);
        }).catch(() => {});
    });

    // Heartbeat every 45 seconds to update logs
    setInterval(async () => {
        try {
            currentGasBalance = await provider.getBalance(signer.address);
            
            // Checks for WETH profit stored in the contract
            const wethBal = await wethContract.balanceOf(CONTRACT_ADDR).catch(() => 0n);
            
            console.log(`[HEARTBEAT] Gas: ${ethers.formatEther(currentGasBalance).substring(0,6)} | Earned (WETH): ${ethers.formatEther(wethBal).substring(0,7)} | Nonce: ${transactionNonce}`);
        } catch (e) {
            console.log("⚠️ Heartbeat lag... still hunting.");
        }
    }, 45000);

    wssProvider.websocket.on("close", () => {
        console.log("🔄 Reconnecting Sniffer...");
        setTimeout(startScanning, 2000);
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
            status: "HUNTING", 
            gas_eth: ethers.formatEther(bal), 
            contract_weth: ethers.formatEther(wethBal) 
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

init().then(() => {
    app.listen(PORT, () => startScanning());
});
