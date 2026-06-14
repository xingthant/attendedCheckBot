// bot.js - Reads configuration from .env file
// Version 3.3 - Fixed Timezone Issue

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// ==================== CONFIGURATION FROM .env ====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || null;
const PORT = process.env.PORT || 3000;

// Validate required configuration
if (!BOT_TOKEN) {
    console.error('❌ FATAL ERROR: BOT_TOKEN not found in .env file!');
    console.error('Please create .env file with BOT_TOKEN=your_token_here');
    process.exit(1);
}

if (ADMIN_IDS.length === 0) {
    console.warn('⚠️ Warning: No ADMIN_IDS configured in .env file');
    console.warn('Add ADMIN_IDS=your_id_here to .env file');
}

// ==================== EXPRESS SERVER FOR RENDER ====================
const app = express();

// employees object needs to be accessible in routes
const employees = {};

// Health check endpoint for Render
app.get('/', (req, res) => {
    res.send('Employee Attendance Bot is running!');
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        employees: Object.keys(employees).length,
        version: '3.3',
        config: {
            bot_configured: !!BOT_TOKEN,
            admins_count: ADMIN_IDS.length,
            group_configured: !!GROUP_CHAT_ID
        }
    });
});

// Start web server
const server = app.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
    console.log(`✅ Health check available at: http://localhost:${PORT}/health`);
});

server.on('error', (error) => {
    console.error('Server error:', error);
});

// Create bot instance with polling enabled
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Mexico Timezone Configuration
const MEXICO_TIMEZONE = 'America/Mexico_City';

// Work start time configuration (8:00 AM Mexico time)
const WORK_START_HOUR = 8;
const WORK_START_MINUTE = 0;
const WORK_START_SECOND = 0;

// Late threshold (15 minutes grace period)
const LATE_THRESHOLD_MINUTES = 15;

const ACTIVITY_TIMEOUT = 15 * 60 * 1000;
let reminderInterval = null;
let lateCheckInterval = null;
let keepAliveInterval = null;

// Activity configurations
const ACTIVITIES = {
    '吃饭': { type: 'meal', name: 'Meal Time' },
    '抽烟': { type: 'smoke', name: 'Smoke Break' },
    '厕所': { type: 'restroom', name: 'Restroom' },
    '下楼拿外卖': { type: 'delivery', name: 'Delivery' }
};

// ==================== TIMEZONE HELPER FUNCTIONS (FIXED) ====================

/**
 * Get current date/time in Mexico timezone
 */
function getMexicoDate() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: MEXICO_TIMEZONE }));
}

/**
 * Get Mexico timezone timestamp (milliseconds since epoch)
 * This ensures all time comparisons are done in Mexico timezone context
 */
function getMexicoTimestamp() {
    const mexicoDate = getMexicoDate();
    // Create a Date object that represents the same wall-clock time in UTC
    // This allows correct comparison with timestamps stored from Date.now()
    return new Date(
        mexicoDate.getFullYear(),
        mexicoDate.getMonth(),
        mexicoDate.getDate(),
        mexicoDate.getHours(),
        mexicoDate.getMinutes(),
        mexicoDate.getSeconds(),
        mexicoDate.getMilliseconds()
    ).getTime();
}

/**
 * Format time with seconds in Mexico timezone
 */
function formatTimeWithSeconds(timestamp) {
    if (!timestamp) return 'N/A';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: false,
        timeZone: MEXICO_TIMEZONE
    });
}

/**
 * Format duration as HH:MM:SS
 */
function formatDurationAsHMS(ms) {
    if (!ms || ms < 0) return '00:00:00';
    
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format duration as Xh Ym Zs
 */
function formatDurationWithSeconds(ms) {
    if (!ms || ms < 0) return '0s';
    
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
    
    return parts.join(' ');
}

/**
 * Get today's work start time as a Mexico-timezone Date object
 */
function getWorkStartTime() {
    const now = getMexicoDate();
    const workStart = new Date(now);
    workStart.setHours(WORK_START_HOUR, WORK_START_MINUTE, WORK_START_SECOND, 0);
    return workStart;
}

/**
 * Get today's work start timestamp for comparison
 */
function getWorkStartTimestamp() {
    const workStart = getWorkStartTime();
    // Convert to UTC timestamp for comparison with Date.now()
    return new Date(
        workStart.getFullYear(),
        workStart.getMonth(),
        workStart.getDate(),
        workStart.getHours(),
        workStart.getMinutes(),
        workStart.getSeconds(),
        workStart.getMilliseconds()
    ).getTime();
}

/**
 * Check if a user is late (FIXED)
 * Compares the start time with Mexico work start time
 */
function isUserLate(startTimestamp) {
    if (!startTimestamp) return false;
    
    const startDate = new Date(startTimestamp);
    const workStartTimestamp = getWorkStartTimestamp();
    const workStartDate = new Date(workStartTimestamp);
    
    // Get hours and minutes in Mexico timezone for both times
    const startMexicoHour = startDate.toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE });
    const startMexicoMinute = startDate.toLocaleTimeString('en-US', { minute: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE });
    const workStartMexicoHour = workStartDate.toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE });
    const workStartMexicoMinute = workStartDate.toLocaleTimeString('en-US', { minute: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE });
    
    const startHour = parseInt(startMexicoHour);
    const startMinute = parseInt(startMexicoMinute);
    const workHour = parseInt(workStartMexicoHour);
    const workMinute = parseInt(workStartMexicoMinute);
    
    // Calculate total minutes after work start
    const startTotalMinutes = startHour * 60 + startMinute;
    const workTotalMinutes = workHour * 60 + workMinute;
    const minutesLate = startTotalMinutes - workTotalMinutes;
    
    // Check if late beyond grace period
    return minutesLate > LATE_THRESHOLD_MINUTES;
}

/**
 * Get late duration in milliseconds (FIXED)
 */
function getLateDuration(startTimestamp) {
    if (!startTimestamp) return 0;
    
    const startDate = new Date(startTimestamp);
    const workStartTimestamp = getWorkStartTimestamp();
    
    // Get Mexico timezone values
    const startMexicoHour = parseInt(startDate.toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE }));
    const startMexicoMinute = parseInt(startDate.toLocaleTimeString('en-US', { minute: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE }));
    const startMexicoSecond = parseInt(startDate.toLocaleTimeString('en-US', { second: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE }));
    
    const workStartDate = new Date(workStartTimestamp);
    const workMexicoHour = parseInt(workStartDate.toLocaleTimeString('en-US', { hour: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE }));
    const workMexicoMinute = parseInt(workStartDate.toLocaleTimeString('en-US', { minute: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE }));
    const workMexicoSecond = parseInt(workStartDate.toLocaleTimeString('en-US', { second: '2-digit', hour12: false, timeZone: MEXICO_TIMEZONE }));
    
    // Calculate milliseconds late
    const startTotalMs = (startMexicoHour * 3600 + startMexicoMinute * 60 + startMexicoSecond) * 1000;
    const workTotalMs = (workMexicoHour * 3600 + workMexicoMinute * 60 + workMexicoSecond) * 1000;
    const lateMs = startTotalMs - workTotalMs;
    
    return Math.max(0, lateMs);
}

/**
 * Get formatted late duration
 */
function getLateDurationFormatted(startTimestamp) {
    const lateMs = getLateDuration(startTimestamp);
    return formatDurationAsHMS(lateMs);
}

/**
 * Send notification to group and admins
 */
async function sendNotification(message, parseMode = 'Markdown') {
    let sent = false;
    
    if (GROUP_CHAT_ID) {
        try {
            await bot.sendMessage(GROUP_CHAT_ID, message, { parse_mode: parseMode });
            sent = true;
            console.log('✅ Notification sent to group');
        } catch (err) {
            console.error(`Failed to send to group:`, err.message);
        }
    }
    
    for (const adminId of ADMIN_IDS) {
        if (adminId && adminId.trim()) {
            try {
                await bot.sendMessage(adminId.trim(), message, { parse_mode: parseMode });
                console.log(`✅ Notification sent to admin ${adminId}`);
                sent = true;
            } catch (err) {
                if (err.message.includes('bot can\'t initiate conversation')) {
                    console.log(`⚠️ Admin ${adminId} needs to start a conversation first`);
                } else {
                    console.error(`Failed to notify admin ${adminId}:`, err.message);
                }
            }
        }
    }
    
    if (!sent) {
        console.log('📝 Notification (no recipients):', message.substring(0, 100));
    }
}

/**
 * Create a user mention for Telegram
 */
function mentionUser(name, telegramId) {
    return `[${name}](tg://user?id=${telegramId})`;
}

/**
 * Get or create user info from message
 */
async function getUserInfo(msg) {
    if (msg.chat.type === 'channel') {
        console.warn('⚠️ Bot received a channel post');
        const telegramId = 'channel_' + msg.chat.id;
        const name = 'Channel User';
        
        if (!employees[telegramId]) {
            employees[telegramId] = {
                name: name,
                telegramId: telegramId,
                status: 'off',
                workStart: null,
                workEnd: null,
                currentActivity: null,
                activityStart: null,
                reminderSent: false,
                lateNotified: false,
                currentChatId: msg.chat.id,
                totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 },
                dailyReport: {
                    workStart: null,
                    workEnd: null,
                    totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 }
                }
            };
        }
        return { telegramId, name };
    }
    
    const from = msg.from;
    if (!from) {
        throw new Error('Cannot identify user');
    }
    
    const telegramId = from.id.toString();
    const name = from.first_name + (from.last_name ? ' ' + from.last_name : '');
    
    if (!employees[telegramId]) {
        employees[telegramId] = {
            name: name,
            telegramId: telegramId,
            status: 'off',
            workStart: null,
            workEnd: null,
            currentActivity: null,
            activityStart: null,
            reminderSent: false,
            lateNotified: false,
            currentChatId: msg.chat.id,
            totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 },
            dailyReport: {
                workStart: null,
                workEnd: null,
                totals: { meal: 0, smoke: 0, restroom: 0, delivery: 0 }
            }
        };
    } else {
        employees[telegramId].currentChatId = msg.chat.id;
    }
    
    return { telegramId, name };
}

/**
 * Check for activity timeouts (unchanged)
 */
function checkActivityTimeouts() {
    const now = Date.now();
    
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        
        if (emp.status === 'away' && emp.currentActivity && emp.activityStart && !emp.reminderSent) {
            const duration = now - emp.activityStart;
            
            if (duration >= ACTIVITY_TIMEOUT) {
                let activityDisplay = '';
                for (const [key, config] of Object.entries(ACTIVITIES)) {
                    if (config.type === emp.currentActivity) {
                        activityDisplay = config.name;
                        break;
                    }
                }
                
                const durationFormatted = formatDurationWithSeconds(duration);
                const durationHMS = formatDurationAsHMS(duration);
                const userMention = mentionUser(emp.name, telegramId);
                
                const reminderMessage = `⚠️ ACTIVITY REMINDER\n\n${userMention} has been on ${activityDisplay} for over 15 minutes!\n\n⏱️ Duration: ${durationFormatted} (${durationHMS})\n\nPlease click 返回 (Back) to continue working.`;
                
                bot.sendMessage(emp.currentChatId || telegramId, reminderMessage, { parse_mode: 'Markdown' }).catch(err => {
                    console.error(`Failed to send reminder:`, err.message);
                });
                
                const adminMessage = `⚠️ Activity Alert\n\n${userMention} has been on ${activityDisplay} for ${durationFormatted}`;
                sendNotification(adminMessage, 'Markdown');
                
                emp.reminderSent = true;
                console.log(`[REMINDER] ${emp.name} - ${durationFormatted}`);
            }
        }
    }
}

/**
 * Check for late arrivals (FIXED - uses Mexico time for hour check)
 */
function checkLateArrivals() {
    const mexicoNow = getMexicoDate();
    const currentHour = mexicoNow.getHours();
    
    // Only check between 8:00 AM and 12:00 PM Mexico time
    if (currentHour < 8 || currentHour > 12) {
        return;
    }
    
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        
        // Check if employee has started work and late notification not sent yet
        if (emp.status !== 'off' && emp.workStart && !emp.lateNotified) {
            if (isUserLate(emp.workStart)) {
                const lateDurationMs = getLateDuration(emp.workStart);
                const lateDurationHMS = formatDurationAsHMS(lateDurationMs);
                const lateDurationText = formatDurationWithSeconds(lateDurationMs);
                const userMention = mentionUser(emp.name, telegramId);
                
                const lateMessage = `⚠️ LATE ARRIVAL\n\n${userMention} started work late!\n⏱️ Late by: ${lateDurationText} (${lateDurationHMS})`;
                
                sendNotification(lateMessage, 'Markdown');
                
                emp.lateNotified = true;
                console.log(`[LATE] ${emp.name} - ${lateDurationText}`);
            }
        }
    }
}

/**
 * Start keep-alive pings
 */
function startKeepAlive() {
    keepAliveInterval = setInterval(() => {
        const timestamp = new Date().toISOString();
        console.log(`💓 Keep-alive ping at ${timestamp}`);
        fetch(`http://localhost:${PORT}/health`).catch(() => {});
    }, 14 * 60 * 1000);
    console.log('✅ Keep-alive system started (pings every 14 minutes)');
}

/**
 * Start reminder systems
 */
function startReminderSystems() {
    if (reminderInterval) clearInterval(reminderInterval);
    reminderInterval = setInterval(() => checkActivityTimeouts(), 60 * 1000);
    console.log('✅ Activity reminder system started');
    
    if (lateCheckInterval) clearInterval(lateCheckInterval);
    lateCheckInterval = setInterval(() => checkLateArrivals(), 60 * 1000);
    console.log('✅ Late arrival checker started');
}

// ==================== KEYBOARD LAYOUT ====================
const mainKeyboard = {
    reply_markup: {
        keyboard: [
            ['上班', '下班'],
            ['吃饭', '抽烟'],
            ['厕所', '下楼拿外卖'],
            ['返回']
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// ==================== BOT COMMAND HANDLERS ====================

bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    const helpMessage = `*Bot Usage Guide*

Work Hours: 8:00 AM Mexico Time
Late Threshold: 15 minutes
Activity Limit: 15 minutes

*Commands:*
/start - Welcome message
/status - View employee status
/report - View daily report
/mytime - Check Mexico time
/help - Show this message

*Buttons:*
上班 - Start work
下班 - Finish work
吃饭, 抽烟, 厕所, 下楼拿外卖 - Take breaks
返回 - Return from break`;
    
    bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (msg.chat.type === 'channel') {
        bot.sendMessage(chatId, 'Please add me to a GROUP for tracking.');
        return;
    }
    
    try {
        const { name, telegramId } = await getUserInfo(msg);
        employees[telegramId].currentChatId = chatId;
        
        const welcomeMessage = `Welcome ${name}!

Work Hours: 8:00 AM Mexico Time
Activity Limit: 15 minutes

Use the buttons below to track your work.`;
        
        bot.sendMessage(chatId, welcomeMessage, mainKeyboard);
        
        const userMention = mentionUser(name, telegramId);
        sendNotification(`User Active\n\n${userMention} started using the bot.`, 'Markdown');
    } catch (error) {
        console.error('Error in /start:', error);
        bot.sendMessage(chatId, '❌ Error identifying user.');
    }
});

bot.onText(/\/mytime/, async (msg) => {
    const chatId = msg.chat.id;
    const mexicoTime = getMexicoDate();
    const workStartTime = getWorkStartTime();
    
    const timeMessage = `*Current Mexico Time*

📅 Date: ${mexicoTime.toLocaleDateString('zh-CN')}
⏱️ Time: ${formatTimeWithSeconds(mexicoTime.getTime())}

🏢 Work Start: ${formatTimeWithSeconds(workStartTime.getTime())}
⏰ Late After: ${WORK_START_HOUR + Math.floor((WORK_START_MINUTE + LATE_THRESHOLD_MINUTES) / 60)}:${(WORK_START_MINUTE + LATE_THRESHOLD_MINUTES) % 60}`;
    
    bot.sendMessage(chatId, timeMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    const working = [];
    const away = [];
    const late = [];
    
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        
        if (emp.status === 'working') {
            let workingText = `${emp.name}`;
            if (isUserLate(emp.workStart)) {
                workingText += ` (Late by ${getLateDurationFormatted(emp.workStart)})`;
                late.push(emp.name);
            }
            working.push(workingText);
        } else if (emp.status === 'away') {
            let activityDisplay = '';
            for (const [key, config] of Object.entries(ACTIVITIES)) {
                if (config.type === emp.currentActivity) {
                    activityDisplay = config.name;
                    break;
                }
            }
            const duration = emp.activityStart ? Date.now() - emp.activityStart : 0;
            away.push(`${emp.name} - ${activityDisplay} (${formatDurationWithSeconds(duration)})`);
        }
    }
    
    let statusMessage = '*Employee Status*\n\n';
    statusMessage += '🟢 WORKING\n';
    statusMessage += working.length > 0 ? working.join('\n') : 'None\n';
    if (late.length > 0) {
        statusMessage += `\n⚠️ Late Arrivals: ${late.length}\n`;
    }
    statusMessage += '\n🟡 AWAY\n';
    statusMessage += away.length > 0 ? away.join('\n') : 'None';
    
    bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

bot.onText(/\/report/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (Object.keys(employees).length === 0) {
        bot.sendMessage(chatId, 'No employee data available yet.');
        return;
    }
    
    let reportMessage = '*Daily Work Report*\n\n';
    
    for (const [telegramId, emp] of Object.entries(employees)) {
        if (telegramId.startsWith('channel_')) continue;
        
        const workStart = emp.dailyReport.workStart || emp.workStart;
        const workEnd = emp.dailyReport.workEnd || emp.workEnd;
        const totals = emp.dailyReport.totals || emp.totals;
        
        let totalWorkMs = 0;
        let isLate = false;
        
        if (workStart && workEnd) {
            totalWorkMs = workEnd - workStart;
            totalWorkMs -= (totals.meal + totals.smoke + totals.restroom + totals.delivery);
            isLate = isUserLate(workStart);
        }
        
        reportMessage += `*${emp.name}*\n`;
        reportMessage += `Start: ${formatTimeWithSeconds(workStart)}\n`;
        reportMessage += `Finish: ${formatTimeWithSeconds(workEnd)}\n`;
        if (isLate) reportMessage += `⚠️ Late by: ${getLateDurationFormatted(workStart)}\n`;
        reportMessage += `\n*Breakdown:*\n`;
        reportMessage += `🍚 Meal: ${formatDurationWithSeconds(totals.meal)}\n`;
        reportMessage += `🚬 Smoke: ${formatDurationWithSeconds(totals.smoke)}\n`;
        reportMessage += `🚽 Restroom: ${formatDurationWithSeconds(totals.restroom)}\n`;
        reportMessage += `📦 Delivery: ${formatDurationWithSeconds(totals.delivery)}\n`;
        reportMessage += `\n✅ Total Work: ${formatDurationWithSeconds(totalWorkMs)}\n\n`;
    }
    
    bot.sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
});

// ==================== BUTTON HANDLERS ====================

bot.onText(/上班/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const { telegramId, name } = await getUserInfo(msg);
        const emp = employees[telegramId];
        
        emp.currentChatId = chatId;
        
        if (emp.status === 'working') {
            bot.sendMessage(chatId, '❌ You have already started work today!');
            return;
        }
        
        if (emp.status === 'away') {
            bot.sendMessage(chatId, '❌ Please finish your current activity (click 返回) before starting work.');
            return;
        }
        
        const now = Date.now();
        
        emp.status = 'working';
        emp.workStart = now;
        emp.workEnd = null;
        emp.currentActivity = null;
        emp.activityStart = null;
        emp.reminderSent = false;
        emp.lateNotified = false;
        emp.totals = { meal: 0, smoke: 0, restroom: 0, delivery: 0 };
        emp.dailyReport = {
            workStart: now,
            workEnd: null,
            totals: { ...emp.totals }
        };
        
        const late = isUserLate(now);
        const actualTimeFormatted = formatTimeWithSeconds(now);
        
        let response = `✅ ${name} started work\n⏱️ ${actualTimeFormatted}`;
        
        if (late) {
            const lateDurationText = formatDurationWithSeconds(getLateDuration(now));
            response += `\n\n⚠️ You are late!\n⏱️ Late by: ${lateDurationText}`;
            
            const userMention = mentionUser(name, telegramId);
            sendNotification(`⚠️ LATE ARRIVAL\n\n${userMention} started work at ${actualTimeFormatted}\nLate by: ${lateDurationText}`, 'Markdown');
        }
        
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...mainKeyboard });
        console.log(`[LOG] ${name} started at ${actualTimeFormatted} ${late ? '(LATE)' : '(ON TIME)'}`);
    } catch (error) {
        console.error('Error in 上班:', error);
        bot.sendMessage(chatId, '❌ Error processing request.');
    }
});

bot.onText(/下班/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const { telegramId, name } = await getUserInfo(msg);
        const emp = employees[telegramId];
        
        if (emp.status !== 'working' && emp.status !== 'away') {
            bot.sendMessage(chatId, '❌ You haven\'t started work yet! Please click 上班 first.');
            return;
        }
        
        if (emp.status === 'away') {
            await handleReturn(telegramId, name, chatId);
        }
        
        const now = Date.now();
        emp.workEnd = now;
        emp.dailyReport.workEnd = now;
        emp.status = 'off';
        
        let workDurationMs = emp.workEnd - emp.workStart;
        const totalBreaks = emp.totals.meal + emp.totals.smoke + emp.totals.restroom + emp.totals.delivery;
        workDurationMs -= totalBreaks;
        
        const response = `✅ ${name} finished work\n\n📊 Work Summary:\n⏱️ Work Duration: ${formatDurationWithSeconds(workDurationMs)}\n⏱️ Break Time: ${formatDurationWithSeconds(totalBreaks)}`;
        
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown', ...mainKeyboard });
        console.log(`[LOG] ${name} finished at ${formatTimeWithSeconds(now)}`);
    } catch (error) {
        console.error('Error in 下班:', error);
        bot.sendMessage(chatId, '❌ Error processing request.');
    }
});

for (const [activityText, config] of Object.entries(ACTIVITIES)) {
    bot.onText(new RegExp(activityText), async (msg) => {
        const chatId = msg.chat.id;
        
        try {
            const { telegramId, name } = await getUserInfo(msg);
            const emp = employees[telegramId];
            
            if (emp.status !== 'working') {
                bot.sendMessage(chatId, '❌ You must start work first (click 上班) before taking a break.');
                return;
            }
            
            if (emp.status === 'away') {
                bot.sendMessage(chatId, '❌ You are already on a break. Please click 返回 to continue working.');
                return;
            }
            
            const now = Date.now();
            emp.status = 'away';
            emp.currentActivity = config.type;
            emp.activityStart = now;
            emp.reminderSent = false;
            
            const response = `✅ ${name} started ${config.name}\n⏱️ ${formatTimeWithSeconds(now)}\n⏱️ Time limit: 15 minutes`;
            bot.sendMessage(chatId, response, mainKeyboard);
            console.log(`[LOG] ${name} started ${config.type}`);
        } catch (error) {
            console.error(`Error in ${activityText}:`, error);
            bot.sendMessage(chatId, '❌ Error processing request.');
        }
    });
}

bot.onText(/返回/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const { telegramId, name } = await getUserInfo(msg);
        const success = await handleReturn(telegramId, name, chatId);
        if (success) {
            bot.sendMessage(chatId, '✅ Ready to continue working!', mainKeyboard);
        }
    } catch (error) {
        console.error('Error in 返回:', error);
        bot.sendMessage(chatId, '❌ Error processing request.');
    }
});

async function handleReturn(telegramId, name, chatId) {
    const emp = employees[telegramId];
    
    if (emp.status !== 'away' || !emp.currentActivity || !emp.activityStart) {
        bot.sendMessage(chatId, '❌ You don\'t have any active activity to return from.');
        return false;
    }
    
    const now = Date.now();
    const durationMs = now - emp.activityStart;
    
    const activityType = emp.currentActivity;
    if (emp.totals[activityType] !== undefined) {
        emp.totals[activityType] += durationMs;
        if (emp.dailyReport.totals[activityType] !== undefined) {
            emp.dailyReport.totals[activityType] += durationMs;
        }
    }
    
    let activityDisplay = '';
    for (const [key, config] of Object.entries(ACTIVITIES)) {
        if (config.type === activityType) {
            activityDisplay = config.name;
            break;
        }
    }
    
    emp.status = 'working';
    emp.currentActivity = null;
    emp.activityStart = null;
    emp.reminderSent = false;
    
    const response = `✅ ${name} returned\n\n📊 Activity: ${activityDisplay}\n⏱️ Duration: ${formatDurationWithSeconds(durationMs)}`;
    
    bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    console.log(`[LOG] ${name} returned - Duration: ${formatDurationWithSeconds(durationMs)}`);
    return true;
}

// ==================== ERROR HANDLING ====================

bot.on('polling_error', (error) => {
    console.error('Polling error:', error.message);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing...');
    if (reminderInterval) clearInterval(reminderInterval);
    if (lateCheckInterval) clearInterval(lateCheckInterval);
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

// ==================== STARTUP ====================

console.log('🚀 Starting Employee Attendance Bot v3.3');
console.log('================================================');
console.log(`✅ Timezone: ${MEXICO_TIMEZONE}`);
console.log(`✅ Work start: ${WORK_START_HOUR}:${WORK_START_MINUTE}:${WORK_START_SECOND}`);
console.log(`✅ Late threshold: ${LATE_THRESHOLD_MINUTES} minutes`);
console.log(`✅ Admins: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(', ') : 'None configured'}`);
console.log(`✅ Group Chat: ${GROUP_CHAT_ID || 'Not set'}`);
console.log(`✅ Bot Token: ${BOT_TOKEN ? 'Configured ✓' : 'Missing ✗'}`);
console.log('✅ In-memory storage ready');

startReminderSystems();
startKeepAlive();

console.log('================================================');
console.log('🎉 Bot is running!');
console.log('📊 Commands: /start, /status, /report, /mytime, /help');
console.log(`🕐 Current Mexico Time: ${formatTimeWithSeconds(getMexicoDate().getTime())}`);
console.log(`🏢 Work Start (Mexico): ${formatTimeWithSeconds(getWorkStartTimestamp())}`);
console.log('================================================');
