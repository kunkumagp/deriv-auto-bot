// over_under_bot.js
// Node.js version of over_under.js logic (no DOM, uses console)

const WebSocket = require('ws');
require('dotenv').config();
const readline = require('readline');

// ============ CONFIGURATION ============
const accounts = [
    { name: "KunkumaGP", value: "lkUxtOopvUhCpIX" },
    { name: "Kunkuma Trading", value: "YbaIy3dD51g2eoO" },
    { name: "W H K G Prasanna 85", value: "iVOpdm24hBhw3JI" },
    { name: "Zion Music 1985", value: "pfn80VW8Lexav5O" },
    { name: "Test Mail", value: "zAhDnvk9VOUB5rD" },
];

const marketArray2 = [
    { value: "R_10", name: "Volatility 10 Index" },
    { value: "R_25", name: "Volatility 25 Index" },
    { value: "R_50", name: "Volatility 50 Index" },
    { value: "R_75", name: "Volatility 75 Index" },
    { value: "R_100", name: "Volatility 100 Index" },
];



const overUnderDigitArray = [
    { digit: 0, name: "0", over_payout_percentage: 9, under_payout_percentage: null },
    { digit: 1, name: "1", over_payout_percentage: 23, under_payout_percentage: 793 },
    { digit: 2, name: "2", over_payout_percentage: 40, under_payout_percentage: 372 },
    { digit: 3, name: "3", over_payout_percentage: 63, under_payout_percentage: 221 },
    { digit: 4, name: "4", over_payout_percentage: 95, under_payout_percentage: 143 },
    { digit: 5, name: "5", over_payout_percentage: 143, under_payout_percentage: 95 },
    { digit: 6, name: "6", over_payout_percentage: 221, under_payout_percentage: 63 },
    { digit: 7, name: "7", over_payout_percentage: 372, under_payout_percentage: 40 },
    { digit: 8, name: "8", over_payout_percentage: 793, under_payout_percentage: 23 },
    { digit: 9, name: "9", over_payout_percentage: null, under_payout_percentage: 9 },
];

// ============ BOT STATE ============
let initialAccountBalance = 0,
    updatedAccountBalance = 0,
    stake = 0,
    targetProfitPercentagePerSession = 2,
    amountPercentagePerTrade = 0.35,
    martingaleMultiplier3 = 3,
    dayTargetPercentage = 5,
    marketInterval = 2000,
    selectedOverUnderDigit = overUnderDigitArray.find(item => item.name === "2"),
    market = marketArray2[0].value,
    apiToken = process.env.DERIV_API_TOKEN || accounts[1].value,
    ws,
    isRunning = true,
    isTradeOpen = false,
    lostCountInRow = 0,
    currentProfitAmount = 0,
    currentLossAmount = 0,
    totalTradeCount = 0,
    winTradeCount = 0,
    lossTradeCount = 0,
    lastTradeId = null,
    tradeProposal = null,
    recoveryStake = 0,
    isWaitingForRecoveryTrigger = false;

const SRI_LANKA_OFFSET = 5.5 * 60 * 60 * 1000; // UTC+5:30
let dayStartCapital = 0;
let dayTarget = 0;
let tradingStoppedForDay = false;

let initialAmountPerTrade = 0;
let targetProfitPerSession = 0;
let waitingForNextTrade = false;

function getRandomMarket(array, current) {
    let randomIndex;
    let randomMarket;
    do {
        randomIndex = Math.floor(Math.random() * array.length);
        randomMarket = array[randomIndex];
    } while (randomMarket.value === current);
    marketInterval = randomMarket.interval;
    return randomMarket.value;
}

function makeTheTrade(ws) {
    if (tradingStoppedForDay) {
        console.log("Trading stopped for day. Skipping trade execution.");
        return;
    }
    if (tradeProposal && tradeProposal.proposal) {
        const buyRequest = {
            buy: tradeProposal.proposal.id,
            price: stake.toFixed(2)
        };
        console.log("Placing trade:", buyRequest);
        ws.send(JSON.stringify(buyRequest));
    } else {
        console.log("No valid trade proposal to execute.");
    }
}
function calculateMartingale(lostAmount, selectedOverUnderDigit, type = "over") {
    const payoutPercentage = type === "over" 
        ? selectedOverUnderDigit.over_payout_percentage 
        : selectedOverUnderDigit.under_payout_percentage;
    if (!payoutPercentage || payoutPercentage <= 0) {
        throw new Error("Invalid payout percentage");
    }
    const stake = (lostAmount * 1.5) / (payoutPercentage / 100);
    return Number(stake.toFixed(2));
}

function setAccData(balance) {
    initialAccountBalance = balance;
    updatedAccountBalance = balance;
    targetProfitPerSession = Number((initialAccountBalance * (targetProfitPercentagePerSession / 100)).toFixed(2));
    initialAmountPerTrade = Number((initialAccountBalance * (amountPercentagePerTrade / 100)).toFixed(2));
    if (totalTradeCount === 0) {
        stake = initialAmountPerTrade;
        console.log(`Initial stake: $${stake}`);
    }
    console.log(`Account balance: $${initialAccountBalance}`);
    console.log(`Session target: $${targetProfitPerSession}`);
    // Print updated balance after trade
    if (totalTradeCount > 0) {
        console.log(`Updated Deriv balance: $${initialAccountBalance}`);
    }
    // Always set day target after balance is fetched
    setDayTargetAndStake();
    // If cdt command was triggered, set new day target
    if (global.cdtTriggered) {
        global.cdtTriggered = false;
        runScriptForTrade();
    }
}

function startWebSocket() {
    ws = new WebSocket("wss://ws.binaryws.com/websockets/v3?app_id=1089");
    ws.onopen = () => {
        console.log("Connection open");
        ws.send(JSON.stringify({ authorize: apiToken }));
    };
    ws.onmessage = (event) => {
        const wsResponse = JSON.parse(event.data);
        if (wsResponse.msg_type === "authorize") {
            setAccData(wsResponse.authorize.balance);
            runScriptForTrade();
        }
        if (wsResponse.msg_type === "history") {
            const digits = wsResponse.history.prices.map(p => Number(String(p).slice(-1)));
            const over2Count = digits.filter(d => d > 2).length;
            const probability = (over2Count / digits.length) * 100;
            const lastDigits = digits.slice(-5);
            const lastDigit = digits[digits.length - 1];
            if (isWaitingForRecoveryTrigger) {
                if ([0,1,2].includes(lastDigit)) {
                    stake = recoveryStake;
                    market = "R_100";
                    isWaitingForRecoveryTrigger = false;
                    placeOUTrade(market, selectedOverUnderDigit, initialAccountBalance, 1);
                } else {
                        waitWithCountdown(marketInterval / 1000, runScriptForTrade);
                }
                return;
            }
            if (probability >= 70) {
                if (lostCountInRow >= 1) {
                    const criticalDigits = [0,1,2];
                    const count = lastDigits.filter(d => criticalDigits.includes(d)).length;
                    if (count >= 1) {
                        placeOUTrade(market, selectedOverUnderDigit, initialAccountBalance, 1);
                    } else {
                            waitWithCountdown(marketInterval / 1000, runScriptForTrade);
                    }
                } else {
                    placeOUTrade(market, selectedOverUnderDigit, initialAccountBalance, 1);
                }
            } else {
                    waitWithCountdown(marketInterval / 1000, runScriptForTrade);
            }
        }
        if (wsResponse.msg_type === "proposal") {
            tradeProposal = wsResponse;
            makeTheTrade(ws);
        }
        if (wsResponse.msg_type === "buy") {
            lastTradeId = wsResponse.buy.contract_id;
            totalTradeCount++;
            isTradeOpen = true;
            updatedAccountBalance -= stake;
            setTimeout(() => fetchTradeDetails(ws, lastTradeId), 500);
        }
        if (wsResponse.msg_type === "proposal_open_contract") {
            if (wsResponse.proposal_open_contract.contract_id === lastTradeId) {
                const contract = wsResponse.proposal_open_contract;
                if (contract.is_sold) {
                    const profit = contract.profit;
                    updateDetails(contract, profit);
                    stakeChangeForOU(profit > 0 ? "Win" : "Loss");
                    isTradeOpen = false;
                    if (profit < 0) {
                        market = getRandomMarket(marketArray2, market);
                        // Use last lost amount for recovery stake
                        if (lostCountInRow >= 2) {
                            let lastLostAmount = Math.abs(profit); // profit is negative for loss
                            let nextStakeValue = lastLostAmount * martingaleMultiplier3;
                            recoveryStake = nextStakeValue;
                            isWaitingForRecoveryTrigger = true;
                            market = "R_100";
                                waitWithCountdown(getRandomNumber(180, 300), runScriptForTrade);
                        } else {
                                waitWithCountdown(20, runScriptForTrade);
                        }
                    } else {
                        lostCountInRow = 0;
                            waitWithCountdown(10, runScriptForTrade);
                    }
                } else {
                        waitWithCountdown(marketInterval / 1000, () => fetchTradeDetails(ws, lastTradeId));
                }
            }
        }
    };
    ws.onclose = () => {
        console.log("Connection closed");
        if (isRunning) setTimeout(startWebSocket, 1000);
    };
    ws.onerror = (err) => {
        console.error("WebSocket error:", err);
    };
}

function getSriLankaDate() {
    const now = new Date();
    return new Date(now.getTime() + SRI_LANKA_OFFSET);
}

function isNewDay() {
    const today = getSriLankaDate();
    const formatted = today.toISOString().split("T")[0];
    return formatted !== global.lastDayDate;
}

function setDayTargetAndStake() {
    if (!Number.isFinite(initialAccountBalance) || initialAccountBalance <= 0) {
        console.log("Waiting for valid account balance before setting day target.");
        return;
    }
    const today = getSriLankaDate();
    const formatted = today.toISOString().split("T")[0];
    global.lastDayDate = formatted;
    dayStartCapital = initialAccountBalance;
    dayTarget = dayStartCapital * 1.1; // 10% profit target
    tradingStoppedForDay = false;
    // Recover loss first if any
    if (currentLossAmount < 0) {
        stake = Math.abs(currentLossAmount);
        console.log(`Recovering loss. Stake set to $${stake.toFixed(2)}`);
    } else {
        stake = initialAmountPerTrade;
        console.log(`Initial stake set to $${stake.toFixed(2)}`);
    }
    console.log(`Day target set: $${dayTarget.toFixed(2)} (10% from $${dayStartCapital.toFixed(2)})`);
}

function checkDayTarget() {
    if (updatedAccountBalance >= dayTarget) {
        tradingStoppedForDay = true;
        console.log(`Day target achieved! Balance: $${updatedAccountBalance.toFixed(2)} / Target: $${dayTarget.toFixed(2)}. Trading stopped until next day.`);
    }
}

function runScriptForTrade() {
    if (waitingForNextTrade || tradingStoppedForDay) return;
    checkDayTarget();
    if (tradingStoppedForDay) return;
    isRunning = true;
    // Only use markets in marketArray2
    market = getRandomMarket(marketArray2, market);
    ws.send(JSON.stringify({
        ticks_history: market,
        end: "latest",
        count: 1000,
        style: "ticks"
    }));
}

// Schedule daily reset at 7AM Sri Lanka time
function scheduleDailyReset() {
    const now = getSriLankaDate();
    const next7AM = new Date(now);
    next7AM.setHours(7, 0, 0, 0);
    if (now > next7AM) {
        next7AM.setDate(next7AM.getDate() + 1);
    }
    const msUntil7AM = next7AM - now;
    setTimeout(() => {
        setDayTargetAndStake();
        tradingStoppedForDay = false;
        runScriptForTrade();
        scheduleDailyReset();
    }, msUntil7AM);
}

// On bot start, set day target and schedule reset
setDayTargetAndStake();
scheduleDailyReset();

// Command-line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (input) => {
    if (input.trim().toLowerCase() === 'cdt') {
        tradingStoppedForDay = false;
        dayTarget = 0;
        console.log('Day target cleared. Fetching new starting capital from Deriv...');
        ws.send(JSON.stringify({ authorize: apiToken }));
        // When balance is fetched, set new target in setAccData
        global.cdtTriggered = true;
    }
});

// ============ START BOT ============
console.log("Starting Over/Under Bot...");
startWebSocket();

function placeOUTrade(market, selectedbarrierNumber = null, initialAccountBalance = null, tickDuration = 1) {
    if (tradingStoppedForDay) {
        console.log("Trading stopped for day. Not placing new trade.");
        return;
    }
    if (!isTradeOpen) {
        let barrierNumber = selectedbarrierNumber !== null ? selectedbarrierNumber.digit : 2;
        stake = Math.max(Number(stake), 0.35);
        let tradeRequest = {
            proposal: 1,
            amount: stake.toFixed(2),
            basis: 'stake',
            contract_type: 'DIGITOVER',
            currency: 'USD',
            duration: tickDuration,
            duration_unit: 't',
            symbol: market,
            barrier: barrierNumber
        };
        isTradeOpen = true;
        console.log("Sending trade request:", tradeRequest);
        ws.send(JSON.stringify(tradeRequest));
    }
}

// ============ UTILITY AND BOT FUNCTIONS FROM over_under.js ============

function fetchTradeDetails(ws, contractId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error("WebSocket is not open.");
        return;
    }
    const contractDetailsRequest = {
        proposal_open_contract: 1,
        contract_id: contractId,
    };
    ws.send(JSON.stringify(contractDetailsRequest));
}

function updateDetails(contract, lastTradeProfit) {
    const result = lastTradeProfit > 0 ? 'WIN' : 'LOSS';
    if (lastTradeProfit > 0) {
        winTradeCount++;
        lostCountInRow = 0;
        currentProfitAmount += lastTradeProfit;
    } else {
        lossTradeCount++;
        lostCountInRow++;
        currentLossAmount += lastTradeProfit;
    }
    if (currentLossAmount >= 0) currentLossAmount = 0;
    updatedAccountBalance = initialAccountBalance + currentProfitAmount + currentLossAmount;
    let netProfit = updatedAccountBalance - initialAccountBalance;
    console.log(`Trade result: ${result} | Profit: $${lastTradeProfit.toFixed(2)} | Balance: $${updatedAccountBalance.toFixed(2)}`);
    console.log(`Win count: ${winTradeCount}, Loss count: ${lossTradeCount}, Lost in row: ${lostCountInRow}`);
}

function waitWithCountdown(seconds, callback) {
    // Ensure seconds is a valid finite positive integer; default to 2s if not
    let remaining = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 2;
    const interval = setInterval(() => {
        process.stdout.write(`Waiting ${remaining}s before next trade... \r`);
        remaining--;
        if (remaining < 0) {
            clearInterval(interval);
            process.stdout.write('\n');
            if (callback) callback();
        }
    }, 1000);
}
function stakeChangeForOU(status) {
    if (status === "Loss") {
        stake = stake * martingaleMultiplier3;
    } else if (status === "Win") {
        stake = initialAmountPerTrade;
    }
    stake = Math.max(Number(stake), 0.35);
    console.log(`Next stake: $${stake.toFixed(2)}`);
}

function getAuthentication(ws, apiToken) {
    console.log("Authenticating....");
    ws.send(JSON.stringify({ authorize: apiToken }));
}

function getA(AB, B = 0.40) {
    let returnValue = (AB / B) + Number(initialAmountPerTrade);
    return Number(returnValue);
}

function setNextTradeStake(stakeAmount) {
    stakeAmount = Number(stakeAmount);
    stakeAmount = stakeAmount < 0.35 ? 0.35 : stakeAmount;
    nextTradeStake = stakeAmount;
    console.log('Next trade stake:', nextTradeStake);
}

function checkRefreshStatus(){
    let targetPerSession = initialAmountPerTrade * (2/100);
    if(currentProfitAmount >= targetPerSession){
        console.log('Target profit achieved for the session.');
    }
}

function getRandomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
