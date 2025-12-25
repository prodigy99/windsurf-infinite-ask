/**
 * 开发者Anna QQ群: 1076321843
 * GitHub开源：https://github.com/crispvibe/windsurf-infinite-ask
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { BUILD_CONFIG } from './config';

let httpServer: http.Server | null = null;
let currentPanel: vscode.WebviewPanel | undefined = undefined;
let pendingResponse: ((result: { shouldContinue: boolean; userInstruction?: string }) => void) | null = null;
let currentRequestId: number = 0;  // Track request ID to avoid race conditions
let extensionContext: vscode.ExtensionContext;
let actualPort: number = 0;  // The port we actually bound to
let workspaceId: string = '';  // Unique ID for this workspace
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    console.log('Clean Infinite Ask is now active!');
    extensionContext = context;

    // 1. Start IPC server for MCP communication
    startIPCServer();

    // 2. Initial Configuration
    configureMCP(context);
    injectRules(context);

    // 3. Register Manual Command (command name set by build script)
    const cmdPrefix = BUILD_CONFIG.isDev ? 'cleanInfiniteAskDev' : 'cleanInfiniteAsk';
    
    let disposable = vscode.commands.registerCommand(`${cmdPrefix}.configure`, () => {
        configureMCP(context);
        injectRules(context);
        vscode.window.showInformationMessage(`${BUILD_CONFIG.displayName} configured manually.`);
    });

    // 4. Register test command for Webview
    let testCmd = vscode.commands.registerCommand(`${cmdPrefix}.test`, () => {
        showWebviewDialog('测试对话 - 这是一个测试请求').then(result => {
            vscode.window.showInformationMessage(
                `Result: continue=${result.shouldContinue}, instruction=${result.userInstruction || 'none'}`
            );
        });
    });

    // 5. Create status bar item for quick access
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = BUILD_CONFIG.isDev ? '🤖 IA-Dev' : '🤖 IA';
    statusBarItem.tooltip = `${BUILD_CONFIG.displayName} - 点击打开对话框`;
    statusBarItem.command = `${cmdPrefix}.test`;
    statusBarItem.show();

    context.subscriptions.push(disposable, testCmd, statusBarItem);
}

export function deactivate() {
    unregisterPort();
    if (httpServer) {
        httpServer.close();
        httpServer = null;
    }
}

function startIPCServer() {
    if (httpServer) {
        return; // Already running
    }

    // Get workspace ID for port registration
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        workspaceId = workspaceFolders[0].uri.fsPath;
    } else {
        workspaceId = 'default';
    }

    httpServer = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url === '/ask') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const result = await showWebviewDialog(data.reason || '任务已完成');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ shouldContinue: false, error: String(e) }));
                }
            });
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    // Try to bind to a port, starting from base port and incrementing if needed
    tryBindPort(BUILD_CONFIG.ipcPort);
}

function tryBindPort(port: number, maxAttempts: number = 10) {
    if (!httpServer) return;
    
    const attempt = port - BUILD_CONFIG.ipcPort;
    if (attempt >= maxAttempts) {
        console.error(`Failed to bind to any port after ${maxAttempts} attempts`);
        return;
    }

    httpServer.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${port} in use, trying ${port + 1}`);
            tryBindPort(port + 1, maxAttempts);
        } else {
            console.error('IPC server error:', err);
        }
    });

    httpServer.listen(port, '127.0.0.1', () => {
        actualPort = port;
        console.log(`${BUILD_CONFIG.displayName} IPC server listening on port ${actualPort}`);
        registerPort();
    });
}

function registerPort() {
    // Register our port in a file so MCP server can find us
    const portsDir = path.join(os.homedir(), '.infinite-ask', 'ports');
    
    try {
        if (!fs.existsSync(portsDir)) {
            fs.mkdirSync(portsDir, { recursive: true });
        }
        
        // Use a hash of workspace path as filename to avoid path issues
        const workspaceHash = Buffer.from(workspaceId).toString('base64').replace(/[/+=]/g, '_');
        const portFile = path.join(portsDir, `${workspaceHash}.json`);
        
        fs.writeFileSync(portFile, JSON.stringify({
            port: actualPort,
            workspace: workspaceId,
            timestamp: Date.now(),
            isDev: BUILD_CONFIG.isDev
        }), 'utf8');
        
        console.log(`Registered port ${actualPort} for workspace ${workspaceId}`);
    } catch (e) {
        console.error('Failed to register port:', e);
    }
}

function unregisterPort() {
    const portsDir = path.join(os.homedir(), '.infinite-ask', 'ports');
    const workspaceHash = Buffer.from(workspaceId).toString('base64').replace(/[/+=]/g, '_');
    const portFile = path.join(portsDir, `${workspaceHash}.json`);
    
    try {
        if (fs.existsSync(portFile)) {
            fs.unlinkSync(portFile);
            console.log(`Unregistered port for workspace ${workspaceId}`);
        }
    } catch (e) {
        console.error('Failed to unregister port:', e);
    }
}

let lastReason: string = '';

function reopenDialog() {
    // Recreate the panel with the last reason
    createPanelIfNeeded();
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        currentPanel.webview.postMessage({ type: 'showDialog', reason: lastReason || '请继续操作' });
    }
}

function createPanelIfNeeded() {
    if (currentPanel) return;
    
    currentPanel = vscode.window.createWebviewPanel(
        'infiniteAskDialog',
        BUILD_CONFIG.displayName,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(extensionContext.extensionPath, 'assets'))
            ]
        }
    );
    currentPanel.webview.html = getWebviewContent();
    
    // Handle messages from the webview
    currentPanel.webview.onDidReceiveMessage(
        message => {
            if (message.type === 'response' && pendingResponse) {
                const result = {
                    shouldContinue: message.shouldContinue,
                    userInstruction: message.userInstruction
                };
                pendingResponse(result);
                pendingResponse = null;
            }
        },
        undefined,
        extensionContext.subscriptions
    );

    // Handle panel disposal
    currentPanel.onDidDispose(
        () => {
            currentPanel = undefined;
            if (pendingResponse) {
                vscode.window.showWarningMessage(
                    'Infinite Ask 对话框已关闭。点击重新打开继续操作，或结束对话。',
                    '重新打开',
                    '结束对话'
                ).then(choice => {
                    if (choice === '重新打开' && pendingResponse) {
                        reopenDialog();
                    } else if (pendingResponse) {
                        pendingResponse({ shouldContinue: false });
                        pendingResponse = null;
                    }
                });
            }
        },
        undefined,
        extensionContext.subscriptions
    );
}

async function showWebviewDialog(reason: string): Promise<{ shouldContinue: boolean; userInstruction?: string }> {
    return new Promise((resolve) => {
        currentRequestId++;
        pendingResponse = resolve;
        lastReason = reason;

        createPanelIfNeeded();
        
        if (currentPanel) {
            currentPanel.reveal(vscode.ViewColumn.One);
            currentPanel.webview.postMessage({ type: 'showDialog', reason });
        }
    });
}

function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${BUILD_CONFIG.displayName}</title>
    <style>
        :root {
            --bg-color: #1e1e1e;
            --card-bg: #252526;
            --border-color: #3c3c3c;
            --text-primary: #cccccc;
            --text-secondary: #888888;
            --accent-color: #0078d4;
            --accent-hover: #1a8cd8;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-color);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            width: 100%;
            max-width: 500px;
            background: var(--card-bg);
            border-radius: 12px;
            border: 1px solid var(--border-color);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, var(--accent-color), #5c2d91);
            padding: 24px;
            text-align: center;
        }
        .header h1 { font-size: 24px; font-weight: 600; margin-bottom: 8px; color: white; }
        .header .subtitle { font-size: 14px; opacity: 0.9; color: rgba(255,255,255,0.9); }
        .content { padding: 24px; }
        .reason-section { margin-bottom: 24px; }
        .reason-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); margin-bottom: 8px; }
        .reason-box {
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 16px;
            font-size: 14px;
            line-height: 1.6;
            max-height: 150px;
            overflow-y: auto;
        }
        .input-section { margin-bottom: 24px; }
        .input-label { font-size: 14px; font-weight: 500; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
        .input-label .optional { font-size: 12px; color: var(--text-secondary); font-weight: normal; }
        .instruction-input {
            width: 100%;
            background: var(--bg-color);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 14px;
            font-size: 14px;
            color: var(--text-primary);
            resize: vertical;
            min-height: 100px;
            transition: border-color 0.2s;
        }
        .instruction-input:focus { outline: none; border-color: var(--accent-color); }
        .instruction-input::placeholder { color: var(--text-secondary); }
        .buttons { display: flex; gap: 12px; }
        .btn {
            flex: 1;
            padding: 14px 24px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .btn-primary { background: var(--accent-color); color: white; }
        .btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }
        .btn-secondary { background: transparent; color: var(--text-primary); border: 1px solid var(--border-color); }
        .btn-secondary:hover { background: var(--border-color); }
        .icon { width: 18px; height: 18px; }
        .footer { padding: 16px 24px; background: var(--bg-color); border-top: 1px solid var(--border-color); text-align: center; font-size: 12px; color: var(--text-secondary); }
        .status { display: none; padding: 24px; text-align: center; }
        .status.show { display: block; }
        .status-icon { font-size: 48px; margin-bottom: 16px; }
        .status-text { font-size: 16px; color: var(--text-primary); }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .waiting { animation: pulse 2s ease-in-out infinite; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 ${BUILD_CONFIG.displayName}</h1>
            <div class="subtitle">AI助手请求继续对话</div>
        </div>
        <div class="content" id="mainContent">
            <div class="reason-section">
                <div class="reason-label">AI想要结束的原因</div>
                <div class="reason-box" id="reasonText">任务已完成</div>
            </div>
            <div class="input-section">
                <div class="input-label">下一步指令 <span class="optional">(可选，直接点击继续则不提供额外指令)</span></div>
                <textarea class="instruction-input" id="instructionInput" placeholder="例如：继续优化代码、添加单元测试、修复其他bug..."></textarea>
            </div>
            <div class="buttons">
                <button class="btn btn-primary" id="continueBtn">
                    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                    继续执行
                </button>
                <button class="btn btn-secondary" id="endBtn">
                    <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/></svg>
                    结束对话
                </button>
            </div>
        </div>
        <div class="status" id="statusSection">
            <div class="status-icon" id="statusIcon">✅</div>
            <div class="status-text" id="statusText">已发送响应</div>
        </div>
        <div class="footer">${BUILD_CONFIG.displayName} • 按 Enter 快速继续</div>
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        const continueBtn = document.getElementById('continueBtn');
        const endBtn = document.getElementById('endBtn');
        const instructionInput = document.getElementById('instructionInput');
        const reasonText = document.getElementById('reasonText');
        const mainContent = document.getElementById('mainContent');
        const statusSection = document.getElementById('statusSection');
        const statusIcon = document.getElementById('statusIcon');
        const statusText = document.getElementById('statusText');

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'showDialog') {
                reasonText.textContent = message.reason || '任务已完成';
                instructionInput.value = '';
                mainContent.style.display = 'block';
                statusSection.classList.remove('show');
                instructionInput.focus();
            }
        });

        function sendResponse(shouldContinue) {
            const instruction = instructionInput.value.trim();
            vscode.postMessage({ type: 'response', shouldContinue, userInstruction: instruction || undefined });
            mainContent.style.display = 'none';
            statusSection.classList.add('show');
            if (shouldContinue) {
                statusIcon.textContent = '🚀';
                statusText.textContent = instruction ? '已发送指令，AI正在继续...' : 'AI正在继续执行...';
            } else {
                statusIcon.textContent = '👋';
                statusText.textContent = '对话已结束';
            }
        }

        continueBtn.addEventListener('click', () => sendResponse(true));
        endBtn.addEventListener('click', () => sendResponse(false));
        instructionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendResponse(true); }
        });
        instructionInput.focus();
    </script>
</body>
</html>`;
}

function configureMCP(context: vscode.ExtensionContext) {
    try {
        const mcpServerPath = context.asAbsolutePath(path.join('assets', 'mcp-server', 'index.js'));
        const homeDir = os.homedir();

        // Primary config path for Windsurf (create if not exists)
        const primaryConfigPath = path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json');
        
        // Secondary paths to check (only update if exists)
        const secondaryConfigPaths = [
            path.join(homeDir, '.codeium', 'windsurf-next', 'mcp_config.json'),
            path.join(homeDir, '.codeium', 'mcp_config.json'),
            path.join(homeDir, '.cursor', 'mcp.json') // Cursor support
        ];

        // Always ensure primary config exists and is updated
        ensureConfigExists(primaryConfigPath);
        updateMCPConfig(primaryConfigPath, mcpServerPath);
        console.log(`Updated MCP config at: ${primaryConfigPath}`);

        // Update secondary configs if they exist
        for (const configPath of secondaryConfigPaths) {
            if (fs.existsSync(configPath)) {
                updateMCPConfig(configPath, mcpServerPath);
                console.log(`Updated MCP config at: ${configPath}`);
            }
        }

    } catch (error) {
        console.error('Failed to configure MCP:', error);
    }
}

function ensureConfigExists(configPath: string) {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
        console.log(`Created MCP config at: ${configPath}`);
    }
}

function updateMCPConfig(configPath: string, serverScriptPath: string) {
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(content);

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        // Add or Update MCP configuration (dev or prod)
        // Set environment variables for SSH remote support
        config.mcpServers[BUILD_CONFIG.mcpServerName] = {
            command: 'node',
            args: [serverScriptPath],
            env: {
                INFINITE_ASK_PORT: String(BUILD_CONFIG.ipcPort),
                INFINITE_ASK_HOST: '127.0.0.1'
            }
        };

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
        console.error(`Error updating ${configPath}:`, e);
    }
}

function injectRules(context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const rulesSource = context.asAbsolutePath(path.join('assets', 'rules', 'windsurf-rules.md'));

    try {
        const rulesContent = fs.readFileSync(rulesSource, 'utf8');

        for (const folder of workspaceFolders) {
            const ruleFile = path.join(folder.uri.fsPath, '.windsurfrules');

            // Only create if not exists to avoid overwriting user customizations
            if (!fs.existsSync(ruleFile)) {
                fs.writeFileSync(ruleFile, rulesContent, 'utf8');
                vscode.window.showInformationMessage(`Injected .windsurfrules into ${folder.name}`);
            } else {
                // Determine if we should update? For now, let's play safe and NOT overwrite.
                // Or maybe check if it's empty.
                const currentContent = fs.readFileSync(ruleFile, 'utf8');
                if (currentContent.trim() === '') {
                    fs.writeFileSync(ruleFile, rulesContent, 'utf8');
                }
            }
        }
    } catch (e) {
        console.error('Failed to inject rules:', e);
    }
}
