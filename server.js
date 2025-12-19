// ===============================================================================
// APEX UNIFIED MASTER v12.8.5 (BIG-FISH EDITION: NITRO SPEED + GAS SAVER)
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
const CONTRACT_ADDR = "0x83EF5c401fAa5B9674BAfAcFb089b30bAc67C9A0";
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

const ABI = [
    "function executeFlashArbitrage(address tokenA, address tokenOut, uint256 amount) external",
    "function getContractBalance() external view returns (uint256)",
    "function withdraw() external"
];

let provider, signer, flashContract, transactionNonce, currentGasBalance;

// 2. STABILIZED BOOT
async function init() {
    console.log("-----------------------------------------");
    console.log("🐋 APEX v12.8.5: BIG-FISH GAS SAVER ACTIVE");
    const network = ethers.Network.from(8453); 

    try {
        const configs = RPC_POOL.map((url, i) => ({
            provider: new ethers.JsonRpcProvider(url, network, { staticNetwork: true }),
            priority: i === 0 ? 1 : 2,
            stallTimeout: 2000
        }));

        provider = new ethers.FallbackProvider(configs, network, { quorum: 1 });
        signer = new ethers.Wallet(PRIVATE_KEY, provider);
        flashContract = new ethers.Contract(CONTRACT_ADDR, ABI, signer);
        
        const block = await provider.getBlockNumber();
        currentGasBalance = await provider.getBalance(signer.address);
        transactionNonce = await provider.getTransactionCount(signer.address, 'pending');

        console.log(`✅ [CONNECTED] Block: ${block}`);
        console.log(`[WALLET] Gas: ${ethers.formatEther(currentGasBalance).substring(0, 7)} ETH`);
        console.log(`🎯 [TARGET] Min Whale: ${MIN_WHALE_SIZE} ETH`);
        console.log("-----------------------------------------");
    } catch (e) {
        console.error(`❌ [BOOT ERROR] ${e.message}`);
        setTimeout(init, 5000);
    }
}

// 3. NITRO STRIKE ENGINE (WITH SAFEGUARDS)
function executeApexStrike(targetTx) {
    // A. WHALE FILTER: Skip small trades to save gas
    if (!targetTx || !targetTx.value || targetTx.value < ethers.parseEther(MIN_WHALE_SIZE)) return;

    // B. GAS SAFEGUARD: Protect remaining balance
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
            gasLimit: 850000,
            maxPriorityFeePerGas: ethers.parseUnits("0.15", "gwei"),
            maxFeePerGas: ethers.parseUnits("0.30", "gwei"),
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
                console.log(`⚠️  [REVERT] Competition won the race.`);
            }
        }).catch(() => {});

    }).catch(err => {
        if (err.message.includes("nonce")) {
            provider.getTransactionCount(signer.address, 'pending').then(n => transactionNonce = n);
        }
    });
}

// 4. SCANNER & MONITOR
function startScanning() {
    console.log(`🔍 SNIFFER LIVE: ${WSS_URL.substring(0, 30)}...`);
    const wssProvider = new ethers.WebSocketProvider(WSS_URL);
    
    wssProvider.on("pending", (h) => {
        provider.getTransaction(h).then(tx => {
            if (tx) executeApexStrike(tx);
        }).catch(() => {});
    });

    setInterval(async () => {
        try {
            currentGasBalance = await provider.getBalance(signer.address);
            const earnings = await flashContract.getContractBalance().catch(() => 0n);
            console.log(`[HEARTBEAT] Gas: ${ethers.formatEther(currentGasBalance).substring(0,6)} | Earned: ${ethers.formatEther(earnings)} | Nonce: ${transactionNonce}`);
        } catch (e) {}
    }, 45000);

    wssProvider.websocket.on("close", () => setTimeout(startScanning, 2000));
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
    const bal = await provider.getBalance(signer.address).catch(() => 0n);
    const earnings = await flashContract.getContractBalance().catch(() => 0n);
    res.json({ status: "HUNTING", gas: ethers.formatEther(bal), earned: ethers.formatEther(earnings) });
});

init().then(() => {
    app.listen(PORT, () => startScanning());
});
