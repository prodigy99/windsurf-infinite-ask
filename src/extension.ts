/**
 * 开发者Anna QQ群: 1076321843
 * GitHub开源：https://github.com/crispvibe/windsurf-infinite-ask
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export function activate(context: vscode.ExtensionContext) {
    console.log('Clean Infinite Ask is now active!');

    // 1. Initial Configuration
    configureMCP(context);
    injectRules(context);

    // 2. Register Manual Command
    let disposable = vscode.commands.registerCommand('cleanInfiniteAsk.configure', () => {
        configureMCP(context);
        injectRules(context);
        vscode.window.showInformationMessage('Clean Infinite Ask configured manually.');
    });

    context.subscriptions.push(disposable);
}

export function deactivate() { }

function configureMCP(context: vscode.ExtensionContext) {
    try {
        const mcpServerPath = context.asAbsolutePath(path.join('assets', 'mcp-server', 'index.js'));
        const homeDir = os.homedir();

        // Potential locations for mcp_config.json
        const configPaths = [
            path.join(homeDir, '.codeium', 'windsurf', 'mcp_config.json'),
            path.join(homeDir, '.codeium', 'windsurf-next', 'mcp_config.json'),
            path.join(homeDir, '.codeium', 'mcp_config.json'),
            path.join(homeDir, '.cursor', 'mcp.json') // Cursor support just in case
        ];

        let configFound = false;

        for (const configPath of configPaths) {
            if (fs.existsSync(configPath)) {
                updateMCPConfig(configPath, mcpServerPath);
                configFound = true;
                console.log(`Updated MCP config at: ${configPath}`);
            }
        }

        if (!configFound) {
            console.log('No MCP configuration file found.');
        }

    } catch (error) {
        console.error('Failed to configure MCP:', error);
    }
}

function updateMCPConfig(configPath: string, serverScriptPath: string) {
    try {
        const content = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(content);

        if (!config.mcpServers) {
            config.mcpServers = {};
        }

        // Add or Update infinite_ask configuration
        config.mcpServers['infinite_ask'] = {
            command: 'node',
            args: [serverScriptPath],
            env: {}
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
