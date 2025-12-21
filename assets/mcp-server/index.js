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
const VERSION = '1.0.0-clean';
const REQUEST_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours

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
    // Directly use local popup, no WebSocket fallback needed
    return showLocalPopup(reason);
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