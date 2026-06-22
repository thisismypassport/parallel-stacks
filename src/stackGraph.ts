import * as vscode from 'vscode';
import { outputChannel } from './extension';

export interface StackFrame {
    id: number;
    name: string;
    source?: any;
    line: number;
    column: number;
    threadIds: number[];
}

export interface GraphNode {
    id: string; // Unique ID for the node
    frame: StackFrame;
    children: GraphNode[];
    threadIds: number[]; // Threads that pass through this node
    threadNames: string[]; // Names of threads that pass through this node
    // For rendering
    x?: number;
    y?: number;
}

export interface ThreadData {
    id: number;
    name: string;
    frames: any[];
}

export async function getStackGraph(session: vscode.DebugSession, splitNodes: string[] = [], topDown?: boolean): Promise<GraphNode[]> {
    outputChannel.appendLine(`getStackGraph called for session: ${session.name} (${session.type})`);

    // Check if session type is supported (optional, but good for debugging)
    if (session.type !== 'cppdbg' && session.type !== 'cppvsdbg' && session.type !== 'mock') {
        outputChannel.appendLine(`Warning: Session type '${session.type}' might not be supported.`);
    }

    try {
        const threadsResponse = await session.customRequest('threads');
        outputChannel.appendLine(`Threads response: ${JSON.stringify(threadsResponse)}`);

        if (!threadsResponse || !threadsResponse.threads) {
            throw new Error("Invalid threads response: " + JSON.stringify(threadsResponse));
        }

        const threads = threadsResponse.threads;
        if (threads.length === 0) {
            outputChannel.appendLine('No threads found');
            return [];
        }

        const threadDataPromises = threads.map(async (thread: any) => {
            try {
                // For some debug adapters, we need to be careful with arguments
                // levels: 0 might be interpreted as "return 0 frames" by some adapters (e.g. cppvsdbg)
                // Use a reasonably high number instead.
                const stackTraceResponse = await session.customRequest('stackTrace', { threadId: thread.id, startFrame: 0, levels: 1000 });
                outputChannel.appendLine(`Stack trace for thread ${thread.id}: ${JSON.stringify(stackTraceResponse)}`);

                if (!stackTraceResponse || !stackTraceResponse.stackFrames) {
                    outputChannel.appendLine(`Thread ${thread.id} has no stack frames`);
                    return { id: thread.id, name: thread.name, frames: [] };
                }

                // Reverse to process from root (bottom of stack) to top (leaf)
                if (!topDown) {
                    stackTraceResponse.stackFrames.reverse();
                }

                return {
                    id: thread.id,
                    name: thread.name,
                    frames: stackTraceResponse.stackFrames
                };
            } catch (e: any) {
                outputChannel.appendLine(`Failed to get stack trace for thread ${thread.id}: ${e.message}`);
                return {
                    id: thread.id,
                    name: thread.name,
                    frames: []
                };
            }
        });

        const threadsData: ThreadData[] = await Promise.all(threadDataPromises);
        const graph = buildGraph(threadsData, splitNodes);
        outputChannel.appendLine(`Built graph with ${graph.length} root nodes`);
        return graph;
    } catch (e: any) {
        outputChannel.appendLine(`Failed to get threads: ${e.message}`);
        throw e; // Rethrow so UI shows the error
    }
}

export function buildGraph(threadsData: ThreadData[], splitNodes: string[] = []): GraphNode[] {
    const rootNodes: GraphNode[] = [];

    for (const thread of threadsData) {
        let currentLevelNodes = rootNodes;

        for (const frame of thread.frames) {
            // Calculate Canonical ID for this frame (used for grouping)
            const canonicalId = `${frame.source?.path}:${frame.line}:${frame.column}:${frame.name}`;

            // Determine if this frame should be split (not grouped)
            // If canonicalId is in splitNodes, we do NOT group.
            const shouldSplit = splitNodes.includes(canonicalId);

            // Find if this frame already exists at current level
            // If splitting, we only group if we find a node that is ALREADY specific to this thread (which won't happen here usually)
            // Actually, if we split, we want a UNIQUE node for this thread.
            // So we simply don't find a matching node if shouldSplit is true.
            let node = shouldSplit ? undefined : currentLevelNodes.find(n => isSameFrame(n.frame, frame) && !n.id.includes('::split::'));

            if (!node) {
                // Create new node
                // If splitting, make ID unique by appending thread ID
                const nodeId = shouldSplit ? `${canonicalId}::split::${thread.id}` : canonicalId;

                node = {
                    id: nodeId,
                    frame: {
                        id: frame.id,
                        name: frame.name,
                        source: frame.source,
                        line: frame.line,
                        column: frame.column,
                        threadIds: []
                    },
                    children: [],
                    threadIds: [],
                    threadNames: []
                };
                currentLevelNodes.push(node);
            }

            // Add thread ID to node
            if (!node.threadIds.includes(thread.id)) {
                node.threadIds.push(thread.id);
                node.threadNames.push(thread.name);
            }
            if (!node.frame.threadIds.includes(thread.id)) {
                node.frame.threadIds.push(thread.id);
            }

            // Move to next level
            currentLevelNodes = node.children;
        }
    }

    return rootNodes;
}

function isSameFrame(f1: StackFrame, f2: any): boolean {
    // Basic equality check.
    return f1.name === f2.name &&
        f1.line === f2.line &&
        f1.column === f2.column &&
        (f1.source?.path === f2.source?.path);
}
