#!/usr/bin/env node
"use strict";
/**
 * Clean Infinite Ask MCP Server (Refactored)
 * 
 * 开发者Anna QQ群: 1076321843
 * GitHub开源：https://github.com/crispvibe/windsurf-infinite-ask
 *
 * Changes:
 * - Removed WebSocket/network dependency (Pure Local Mode)
 * - Replaced Zenity with AppleScript for macOS support
 * - Removed obfuscated license checks
 */

const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// ==================== Constants ====================
const VERSION = '1.0.0';
const REQUEST_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours
const IPC_PORT = parseInt(process.env.INFINITE_ASK_PORT || '19824', 10);
const IPC_HOST = process.env.INFINITE_ASK_HOST || '127.0.0.1';
const IPC_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours - user may take a long time to respond

// ==================== Logging ====================
const DEBUG_MODE = process.env.DEBUG_MCP === '1';
function log(level, message, data) {
    if (!DEBUG_MODE) return;
    const timestamp = new Date().toISOString();
    let logMsg = `[${timestamp}] [clean_infinite_ask] [${level}] ${message}`;
    if (data) logMsg += ` | ${JSON.stringify(data)}`;
    process.stderr.write(logMsg + '\n');
}

// ==================== Request Handling ====================
async function sendAskContinue(reason, workspace) {
    // Only use VSCode IPC (Webview dialog)
    // No fallback to system popup - if IPC fails, end conversation
    try {
        const result = await tryVSCodeIPC(reason, workspace);
        if (result !== null) {
            log('INFO', 'Used VSCode IPC dialog', { workspace });
            return result;
        }
    } catch (e) {
        log('ERROR', 'VSCode IPC failed', { error: e.message });
    }
    
    // IPC failed - cannot show dialog
    log('WARN', 'VSCode IPC not available, ending conversation');
    return { shouldContinue: false };
}

// ==================== Port Discovery ====================
function findPortForWorkspace(workspace) {
    const portsDir = path.join(os.homedir(), '.infinite-ask', 'ports');
    
    if (!fs.existsSync(portsDir)) {
        log('DEBUG', 'Ports directory does not exist');
        return null;
    }
    
    // First, try to find exact match by workspace hash
    const workspaceHash = Buffer.from(workspace).toString('base64').replace(/[/+=]/g, '_');
    const exactFile = path.join(portsDir, `${workspaceHash}.json`);
    
    if (fs.existsSync(exactFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(exactFile, 'utf8'));
            log('INFO', `Found exact port match for workspace`, { port: data.port, workspace });
            return data.port;
        } catch (e) {
            log('ERROR', 'Failed to read port file', { file: exactFile, error: e.message });
        }
    }
    
    // Fallback: scan all port files and find the most recent one
    try {
        const files = fs.readdirSync(portsDir).filter(f => f.endsWith('.json'));
        let bestMatch = null;
        let latestTimestamp = 0;
        
        for (const file of files) {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(portsDir, file), 'utf8'));
                if (data.timestamp > latestTimestamp) {
                    latestTimestamp = data.timestamp;
                    bestMatch = data;
                }
            } catch (e) {
                // Skip invalid files
            }
        }
        
        if (bestMatch) {
            log('INFO', `Using most recent port`, { port: bestMatch.port, workspace: bestMatch.workspace });
            return bestMatch.port;
        }
    } catch (e) {
        log('ERROR', 'Failed to scan ports directory', { error: e.message });
    }
    
    return null;
}

// ==================== VSCode IPC ====================
function tryVSCodeIPC(reason, workspace) {
    return new Promise((resolve) => {
        // Try to find the correct port for this workspace
        const port = findPortForWorkspace(workspace) || IPC_PORT;
        
        const http = require('http');
        const postData = JSON.stringify({ reason, workspace });
        
        log('DEBUG', `Connecting to IPC server`, { host: IPC_HOST, port });
        
        const req = http.request({
            hostname: IPC_HOST,
            port: port,
            path: '/ask',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: IPC_TIMEOUT
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (e) {
                    resolve(null);
                }
            });
        });
        
        req.on('error', (e) => {
            log('ERROR', 'IPC request error', { error: e.message });
            resolve(null);
        });
        req.on('timeout', () => {
            log('WARN', 'IPC request timeout');
            req.destroy();
            resolve(null);
        });
        
        req.write(postData);
        req.end();
    });
}

// ==================== Local Popups ====================
async function showLocalPopup(reason) {
    if (process.platform === 'win32') {
        return showWindowsPopup(reason);
    } else if (process.platform === 'darwin') {
        return showMacPopup(reason);
    } else {
        return showLinuxPopup(reason);
    }
}

// Windows (PowerShell + WinForms) - Kept original robust logic
function showWindowsPopup(reason) {
    return new Promise((resolve) => {
        const escapedReason = reason.replace(/'/g, "''").replace(/`/g, "``");
        const tempFile = path.join(os.tmpdir(), `ia_result_${Date.now()}.txt`);
        const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Infinite Ask (Clean)'
$form.Size = New-Object System.Drawing.Size(450, 320)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$lblReason = New-Object System.Windows.Forms.Label
$lblReason.Location = New-Object System.Drawing.Point(15, 10)
$lblReason.Size = New-Object System.Drawing.Size(400, 20)
$lblReason.Text = 'AI想要结束对话的原因：'
$form.Controls.Add($lblReason)
$txtReason = New-Object System.Windows.Forms.TextBox
$txtReason.Location = New-Object System.Drawing.Point(15, 35)
$txtReason.Size = New-Object System.Drawing.Size(400, 50)
$txtReason.Multiline = $true
$txtReason.ReadOnly = $true
$txtReason.Text = '${escapedReason}'
$form.Controls.Add($txtReason)
$lblInst = New-Object System.Windows.Forms.Label
$lblInst.Location = New-Object System.Drawing.Point(15, 95)
$lblInst.Size = New-Object System.Drawing.Size(400, 20)
$lblInst.Text = '输入新指令（可选）：'
$form.Controls.Add($lblInst)
$txtInst = New-Object System.Windows.Forms.TextBox
$txtInst.Location = New-Object System.Drawing.Point(15, 120)
$txtInst.Size = New-Object System.Drawing.Size(400, 80)
$txtInst.Multiline = $true
$form.Controls.Add($txtInst)
$btnContinue = New-Object System.Windows.Forms.Button
$btnContinue.Location = New-Object System.Drawing.Point(100, 220)
$btnContinue.Size = New-Object System.Drawing.Size(100, 35)
$btnContinue.Text = '继续执行'
$btnContinue.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($btnContinue)
$btnEnd = New-Object System.Windows.Forms.Button
$btnEnd.Location = New-Object System.Drawing.Point(230, 220)
$btnEnd.Size = New-Object System.Drawing.Size(100, 35)
$btnEnd.Text = '结束对话'
$btnEnd.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($btnEnd)
$form.AcceptButton = $btnContinue
$form.CancelButton = $btnEnd
$result = $form.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    "CONTINUE:::$($txtInst.Text)" | Out-File -FilePath '${tempFile.replace(/\\/g, '\\\\')}' -Encoding UTF8
} else {
    "END:::" | Out-File -FilePath '${tempFile.replace(/\\/g, '\\\\')}' -Encoding UTF8
}
`;
        const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
            stdio: 'ignore',
            detached: false,
            windowsHide: false
        });

        handlePopupProcess(ps, tempFile, resolve);
    });
}

// MacOS (AppleScript) - New Native Implementation
function showMacPopup(reason) {
    return new Promise((resolve) => {
        // AppleScript 限制：input 只能是单行。为了多行体验，我们这里用简单的 dialog。
        // 如果需要更复杂的，可能需要 JXA (JavaScript for Automation) 或者 Swift bridging，但保持无依赖最重要。
        const escapedReason = reason.replace(/"/g, '\\"').replace(/'/g, "'\\''");

        // 构造 AppleScript
        // 使用 display dialog
        const appleScript = `
        set dialogResult to display dialog "AI想要结束的原因:\\n${escapedReason}\\n\\n请输入新指令(可选):" default answer "" buttons {"结束对话", "继续执行"} default button "继续执行" with title "Infinite Ask" with icon note
        
        if button returned of dialogResult is "继续执行" then
            return "CONTINUE:::" & text returned of dialogResult
        else
            return "END:::"
        end if
        `;

        const p = spawn('osascript', ['-e', appleScript]);

        let output = '';
        p.stdout.on('data', (data) => { output += data.toString(); });

        p.on('close', (code) => {
            // AppleScript output format might contain line breaks, trim it
            output = output.trim();
            // osascript returns result to stdout
            if (output.startsWith('CONTINUE:::')) {
                resolve({
                    shouldContinue: true,
                    userInstruction: output.substring(11) || undefined
                });
            } else {
                resolve({ shouldContinue: false });
            }
        });

        p.on('error', () => resolve({ shouldContinue: false }));
    });
}

// Linux (Zenity) - Kept for backup
function showLinuxPopup(reason) {
    return new Promise((resolve) => {
        const escapedReason = reason.replace(/"/g, '\\"');
        const tempFile = path.join(os.tmpdir(), `ia_result_${Date.now()}.txt`);
        const script = `
result=$(zenity --forms --title="Infinite Ask" \\
    --text="AI想要结束对话的原因：\\n${escapedReason}" \\
    --add-entry="输入新指令（可选）：" \\
    --ok-label="继续执行" \\
    --cancel-label="结束对话" 2>/dev/null)

if [ $? -eq 0 ]; then
    echo "CONTINUE:::$result" > "${tempFile}"
else
    echo "END:::" > "${tempFile}"
fi
`;
        const sh = spawn('bash', ['-c', script], { stdio: 'ignore', detached: false });
        handlePopupProcess(sh, tempFile, resolve);
    });
}

function handlePopupProcess(proc, tempFile, resolve) {
    proc.on('close', () => {
        try {
            if (fs.existsSync(tempFile)) {
                const result = fs.readFileSync(tempFile, 'utf-8').trim();
                fs.unlinkSync(tempFile);
                if (result.startsWith('CONTINUE:::')) {
                    const instruction = result.substring(11).trim();
                    resolve({
                        shouldContinue: true,
                        userInstruction: instruction || undefined
                    });
                } else {
                    resolve({ shouldContinue: false });
                }
            } else {
                resolve({ shouldContinue: false });
            }
        } catch (e) {
            resolve({ shouldContinue: false });
        }
    });
    proc.on('error', () => resolve({ shouldContinue: false }));
}

// ==================== MCP Protocol ====================
const TOOLS = [{
    name: 'infinite_ask',
    description: '当AI想要结束对话或任务时，必须调用此工具询问用户是否继续。',
    inputSchema: {
        type: 'object',
        properties: {
            reason: { type: 'string', description: '结束原因' },
            workspace: { type: 'string' }
        },
        required: ['reason', 'workspace']
    }
}];

function sendResponse(id, result) {
    const response = { jsonrpc: '2.0', id, result };
    console.log(JSON.stringify(response));
}

function sendError(id, code, message) {
    const response = { jsonrpc: '2.0', id, error: { code, message } };
    console.log(JSON.stringify(response));
}

async function handleToolCall(name, args) {
    if (!name.includes('infinite_ask')) {
        throw new Error(`Unknown tool: ${name}`);
    }
    const result = await sendAskContinue(args.reason || '任务已完成', args.workspace);
    let responseText = `结果: should_continue=${result.shouldContinue}`;
    if (result.shouldContinue && result.userInstruction) {
        responseText += `\n用户指令: ${result.userInstruction}`;
    }
    return { content: [{ type: 'text', text: responseText }] };
}

async function handleRequest(request) {
    const { method, id, params } = request;
    try {
        switch (method) {
            case 'initialize':
                sendResponse(id, {
                    protocolVersion: '2024-11-05',
                    serverInfo: { name: 'infinite_ask', version: VERSION },
                    capabilities: { tools: {} }
                });
                break;
            case 'tools/list':
                sendResponse(id, { tools: TOOLS });
                break;
            case 'tools/call':
                const result = await handleToolCall(params.name, params.arguments || {});
                sendResponse(id, result);
                break;
            case 'initialized':
            case 'notifications/cancelled':
                break;
            default:
                if (id !== undefined) sendError(id, -32601, `Unknown method: ${method}`);
        }
    } catch (error) {
        if (id !== undefined) sendError(id, -32603, error.message);
    }
}

// ==================== Main Loop ====================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
});

rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
        const request = JSON.parse(line);
        await handleRequest(request);
    } catch (error) {
        log('ERROR', `Error processing line: ${error.message}`);
    }
});