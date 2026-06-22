// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { ParallelStacksPanel } from './parallelStacksPanel';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export const outputChannel = vscode.window.createOutputChannel("Parallel Stacks");

export function activate(context: vscode.ExtensionContext) {
	outputChannel.appendLine('Parallel Stacks extension activated');

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "parallel-stacks" is now active!');

	const disposable = vscode.commands.registerCommand('parallel-stacks.show', () => {
		ParallelStacksPanel.createOrShow(context.extensionUri);
	});

	context.subscriptions.push(disposable);
	
	vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration("parallel-stacks")) {
			ParallelStacksPanel.updateIfShown();
		}
	});
}

// This method is called when your extension is deactivated
export function deactivate() { }
