import * as vscode from 'vscode';
import { getStackGraph, GraphNode } from './stackGraph';

export class ParallelStacksPanel {
    public static currentPanel: ParallelStacksPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private readonly _activeFrameDecoration: vscode.TextEditorDecorationType;

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it.
        if (ParallelStacksPanel.currentPanel) {
            ParallelStacksPanel.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(
            'parallelStacks',
            'Parallel Stacks',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        ParallelStacksPanel.currentPanel = new ParallelStacksPanel(panel, extensionUri);
    }

    public static updateIfShown() {
        if (ParallelStacksPanel.currentPanel) {
            ParallelStacksPanel.currentPanel._updateGraph([]);
        }
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._activeFrameDecoration = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
            overviewRulerColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
            overviewRulerLane: vscode.OverviewRulerLane.Full,
        });

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'refresh':
                        await this._updateGraph(message.splitNodes || []);
                        return;
                    case 'openFile':
                        await this._openFile(message.source, message.line, message.column);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public dispose() {
        ParallelStacksPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
        this._activeFrameDecoration.dispose();
    }

    private async _updateGraph(splitNodes: string[] = []) {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            this._panel.webview.postMessage({ command: 'error', text: 'No active debug session' });
            return;
        }
        
        const cfg = vscode.workspace.getConfiguration("parallel-stacks");
        const topDown = cfg.get("topdown") as boolean;

        try {
            const graphData = await getStackGraph(session, splitNodes, topDown);

            // Get currently focused thread
            const activeStackItem = vscode.debug.activeStackItem;
            let currentThreadId: number | undefined;
            if (activeStackItem instanceof vscode.DebugThread) {
                currentThreadId = activeStackItem.threadId;
            } else if (activeStackItem instanceof vscode.DebugStackFrame) {
                currentThreadId = activeStackItem.threadId;
            }

            this._panel.webview.postMessage({
                command: 'updateGraph',
                data: graphData,
                topDown: topDown,
                currentThreadId: currentThreadId
            });
        } catch (e: any) {
            this._panel.webview.postMessage({ command: 'error', text: e.message });
        }
    }

    private async _openFile(source: any, line: number, column: number) {
        if (!source || !source.path) {
            return;
        }
        try {
            const uri = 
                source.path.startsWith("vscode-remote://") ?
                vscode.Uri.parse(source.path) :
                vscode.Uri.file(source.path);

            const cfg = vscode.workspace.getConfiguration("parallel-stacks");
            const viewColumnIdx = cfg.get("open-column") as number;
            const viewColumn = viewColumnIdx > 0 ?
                vscode.ViewColumn.One + (viewColumnIdx - 1) :
                vscode.ViewColumn.Active;

            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, viewColumn);
            const pos = new vscode.Position(line - 1, column - 1);

            // Clear decorations from all visible editors to ensure only one highlight
            vscode.window.visibleTextEditors.forEach(e => {
                e.setDecorations(this._activeFrameDecoration, []);
            });

            // Apply decoration
            editor.setDecorations(this._activeFrameDecoration, [new vscode.Range(pos, pos)]);

            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos));
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to open file: ${e.message}`);
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https:;">
        <title>Parallel Stacks</title>
        <script src="https://d3js.org/d3.v7.min.js"></script>
        <style>
            body {
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                padding: 0;
                margin: 0;
                background-color: var(--vscode-editor-background);
                color: var(--vscode-editor-foreground);
                overflow: hidden;
            }
            .error { color: var(--vscode-errorForeground); padding: 20px; }
            .error:empty { padding: 0; }
            #graph { width: 100vw; height: 100vh; overflow: visible; }

            /* Nodes */
            .node rect {
                fill: var(--vscode-sideBar-background);
                stroke: var(--vscode-widget-border);
                stroke-width: 1px;
                rx: 4px; /* Rounded corners */
            }
            .node:hover rect {
                stroke: var(--vscode-focusBorder);
                stroke-width: 2px;
            }
            .node.selected rect {
                stroke: var(--vscode-debugIcon-stackFrameFocusedForeground);
                stroke-width: 3px;
                fill: var(--vscode-editor-hoverHighlightBackground);
            }
            .node.highlighted rect {
                stroke: var(--vscode-focusBorder);
                stroke-width: 2.5px;
            }
            .node.current-thread rect {
                stroke: #007acc4d;
                stroke-width: 2.5px;
            }
            .node.current-thread.highlighted rect {
                stroke: #007acc;
                stroke-width: 3.5px;
                filter: brightness(1.2);
            }
            .node text.name {
                font-weight: bold;
                fill: var(--vscode-editor-foreground);
                pointer-events: none;
            }
            .node text.details {
                font-size: 0.9em;
                fill: var(--vscode-descriptionForeground);
                pointer-events: none;
            }
            .node-thread-count {
                font-size: 0.8em;
                fill: var(--vscode-badge-foreground);
            }
            .node-thread-badge {
                fill: var(--vscode-badge-background);
                pointer-events: all;
                cursor: pointer;
            }
            .node-thread-badge:hover {
                stroke: var(--vscode-focusBorder);
                stroke-width: 2px;
            }
            .node-thread-label-rect {
                fill: var(--vscode-badge-background);
                rx: 3px;
                opacity: 0.8;
            }
            .node-thread-label-text {
                font-size: 10px;
                fill: var(--vscode-badge-foreground);
                font-weight: normal;
            }

            /* Links */
            .link {
                fill: none;
                stroke: var(--vscode-editor-foreground);
                stroke-opacity: 0.2;
                stroke-width: 2px;
            }
            .link.highlighted {
                stroke-opacity: 0.8;
                stroke-width: 3px;
                stroke: var(--vscode-focusBorder);
            }

            /* Tooltip */
            .tooltip {
                position: absolute;
                text-align: left;
                padding: 10px;
                font-size: 12px;
                background: var(--vscode-editor-hoverHighlightBackground);
                border: 1px solid var(--vscode-widget-border);
                border-radius: 4px;
                pointer-events: auto;
                opacity: 0;
                box-shadow: 0 4px 8px rgba(0,0,0,0.2);
                color: var(--vscode-editor-foreground);
                z-index: 100;
                transition: opacity 0.2s;
            }
            .tooltip button {
                margin-top: 8px;
                padding: 4px 8px;
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                border-radius: 2px;
                cursor: pointer;
            }
            .tooltip button:hover {
                background: var(--vscode-button-hoverBackground);
            }
        </style>
    </head>
    <body>
        <div id="error" class="error"></div>
        <div id="graph"></div>
        <div class="tooltip" id="tooltip"></div>
        <script>
            const vscode = acquireVsCodeApi();

            // State
            let splitNodeIds = [];
            let selectedNodeId = null;
            let currentThreadId = null;

            // Handle window resize
            window.addEventListener('resize', () => {
                 if (lastData) renderGraph(lastData, lastTopDown);
            });

            window.addEventListener('message', event => {
                const message = event.data;
                const errorDiv = document.getElementById('error');

                switch (message.command) {
                    case 'updateGraph':
                        errorDiv.textContent = '';
                        lastData = message.data;
                        lastTopDown = message.topDown;
                        currentThreadId = message.currentThreadId;
                        renderGraph(message.data, message.topDown);
                        break;
                    case 'error':
                        errorDiv.textContent = message.text;
                        break;
                }
            });

            let lastData = null;
            let lastTopDown = null;

            function renderGraph(data, topDown) {
                const container = document.getElementById('graph');

                // Fix rendering lag on tab switch (0 size)
                const width = container.clientWidth;
                const height = container.clientHeight;
                if (width === 0 || height === 0) {
                    requestAnimationFrame(() => renderGraph(data));
                    return;
                }

                container.innerHTML = '';

                if (!data || data.length === 0) {
                    container.innerHTML = '<div style="padding: 20px;">No stack data available. Start a debug session.</div>';
                    return;
                }

                const flipTopDown = v => topDown ? -v : v;

                // Prepare data for D3
                const rootData = {
                    id: 'root',
                    frame: { name: 'Root', line: 0, column: 0 },
                    children: data,
                    threadIds: []
                };

                const root = d3.hierarchy(rootData);

                // Calculate dynamic node width based on longest name, BUT cap it
                let maxNameLen = 0;
                root.descendants().forEach(d => {
                   if (d.data.id !== 'root' && d.data.frame && d.data.frame.name) {
                       maxNameLen = Math.max(maxNameLen, d.data.frame.name.length);
                   }
                });

                // Estimate: 7px per char + padding
                const minNodeWidth = 100;
                // Cap the maximum width to keep branches close
                const maxAllowedWidth = 250;
                let calculatedWidth = maxNameLen * 7 + 15;
                if (calculatedWidth > maxAllowedWidth) calculatedWidth = maxAllowedWidth;

                const nodeWidth = Math.max(minNodeWidth, calculatedWidth);
                const nodeHeight = 60;
                const horizontalSpacing = 10;
                const verticalSpacing = 15;

                const treeLayout = d3.tree()
                    .nodeSize([nodeWidth + horizontalSpacing, nodeHeight + verticalSpacing])
                    .separation((a, b) => {
                        // Aggressively reduce separation.
                        // Default is 1 for siblings, 2 for non-siblings.
                        // We want distinct branches to be almost touching.
                        return a.parent === b.parent ? 1 : 1.05;
                    });

                treeLayout(root);

                // Custom Y-positioning: Compact for linear stacks, Original for branches
                root.each(d => {
                    if (!d.parent) {
                        d.y = 0;
                    } else {
                        // Check if the PARENT was a branch point
                        const isBranch = d.parent.children.length > 1;
                        const step = isBranch ? 140 : 70;
                        d.y = d.parent.y + flipTopDown(step);
                    }
                });

                // Define zoom behavior
                const zoom = d3.zoom()
                    .on("zoom", (event) => {
                       g.attr("transform", event.transform);
                       d3.select('#tooltip').style('opacity', 0);
                    });

                // Create SVG
                const svgSelection = d3.select("#graph").append("svg")
                    .attr("width", width)
                    .attr("height", height)
                    .call(zoom)
                    .on("dblclick.zoom", null); // Enable standard zoom, disable double-click zoom

                const g = svgSelection.append("g");

                // Calculate bounds to center the tree initially
                let x0 = Infinity;
                let x1 = -Infinity;
                let y0 = Infinity;
                let y1 = -Infinity;
                root.each(d => {
                    // Ignore root for bounding box if we hide it
                    if (d.data.id === 'root') return;
                    if (d.x < x0) x0 = d.x;
                    if (d.x > x1) x1 = d.x;
                    if (d.y < y0) y0 = d.y;
                    if (d.y > y1) y1 = d.y;
                });

                if (x0 === Infinity) { // Fallback if only root
                     x0 = 0; x1 = 0; y0 = 0; y1 = 0;
                }

                // Bottom-Up Transformation

                const graphWidth = x1 - x0 + nodeWidth;
                const graphHeight = y1 - y0 + nodeHeight;

                const initialScale = Math.min(
                    1,
                    (width - 100) / graphWidth,
                    (height - 100) / graphHeight
                );

                const centerX = (x0 + x1) / 2;
                const centerY = (y0 + y1) / 2; // Center of the visual tree (excluding root)

                const initialTranslateX = (width / 2) - (centerX * initialScale);
                const initialTranslateY = (height / 2) - (-centerY * initialScale);

                // Apply initial zoom
                svgSelection.call(zoom.transform,
                    d3.zoomIdentity.translate(initialTranslateX, initialTranslateY).scale(initialScale)
                );

                // Filter out link to virtual root
                const links = root.links().filter(d => d.source.data.id !== 'root');

                // Draw Links
                const linkSelection = g.selectAll('path.link')
                    .data(links)
                    .enter().append('path')
                    .attr('class', 'link')
                    .attr('d', d => {
                        const sx = d.source.x;
                        const sy = -d.source.y;
                        const tx = d.target.x;
                        const ty = -d.target.y;

                        return 'M' + sx + ',' + sy + 'C' + sx + ',' + ((sy + ty) / 2) + ' ' + tx + ',' + ((sy + ty) / 2) + ' ' + tx + ',' + ty;
                    });

                // Filter out virtual root node
                const nodesData = root.descendants().filter(d => d.data.id !== 'root');

                // Draw Nodes
                const nodes = g.selectAll('g.node')
                    .data(nodesData)
                    .enter().append('g')
                    .attr('class', 'node')
                    .attr('transform', d => 'translate(' + d.x + ',' + (-d.y) + ')')
                    .style("cursor", "pointer")
                    .classed('selected', d => d.data.id === selectedNodeId)
                    .classed('current-thread', d => currentThreadId !== null && d.data.threadIds.includes(currentThreadId))
                    .on("click", function(event, d) {
                         selectedNodeId = d.data.id;
                         nodes.classed('selected', false);
                         d3.select(this).classed('selected', true);

                         if (d.data.frame) {
                             vscode.postMessage({
                                 command: 'openFile',
                                 source: d.data.frame.source,
                                 line: d.data.frame.line,
                                 column: d.data.frame.column
                             });
                         }
                    })
                    .on("mouseover", function(event, d) {
                        // Highlight path to root
                        const pathSet = new Set(d.ancestors());

                        nodes.classed('highlighted', n => pathSet.has(n));
                        linkSelection.classed('highlighted', l => pathSet.has(l.target));
                    })
                    .on("mouseout", function() {
                        nodes.classed('highlighted', false);
                        linkSelection.classed('highlighted', false);
                    });

                // Node Rect/Card
                nodes.append('rect')
                    .attr('x', -nodeWidth / 2)
                    .attr('y', -nodeHeight / 2)
                    .attr('width', nodeWidth)
                    .attr('height', nodeHeight)
                    .attr('rx', 5);

                // Text: Function Name (truncated)
                // Text: Function Name (truncated)
                nodes.append('text')
                    .attr('class', 'name')
                    .attr('dy', '-0.5em')
                    .attr('text-anchor', 'middle')
                    .text(d => {
                        let name = d.data.frame.name;

                        // Parse "Module!Function Line X" -> "Function"
                        const bangIndex = name.indexOf('!');
                        if (bangIndex !== -1) {
                            name = name.substring(bangIndex + 1);
                        }
                        // Strip trailing " Line X" if present, as it's redundant
                        const lineIndex = name.lastIndexOf(' Line ');
                        if (lineIndex !== -1) {
                            name = name.substring(0, lineIndex);
                        }

                        // Truncation
                        const maxChars = Math.floor((nodeWidth - 10) / 7);
                        if (name.length > maxChars) {
                            return name.substring(0, maxChars - 3) + '...';
                        }
                        return name;
                    });

                // Text: Source/Line or Module
                nodes.append('text')
                    .attr('class', 'details')
                    .attr('dy', '1.2em')
                    .attr('text-anchor', 'middle')
                    .text(d => {
                         const rawName = d.data.frame.name;
                         let moduleName = '';
                         const bangIndex = rawName.indexOf('!');
                         if (bangIndex !== -1) {
                             moduleName = rawName.substring(0, bangIndex);
                         }

                         const src = d.data.frame.source ? d.data.frame.source.name : '';
                         const line = d.data.frame.line > 0 ? ' : ' + d.data.frame.line : '';

                         if (src) {
                             if (moduleName) {
                                 // "Module => Source : Line"
                                 return moduleName + ' => ' + src + line;
                             } else {
                                 // "Source : Line"
                                 return src + line;
                             }
                         } else {
                             // No source, check for module
                             if (moduleName) {
                                 return moduleName;
                             }
                             // Fallback
                             return '';
                         }
                    });

                // Gutter labels for threads at the TOP of branches (leaves)
                const leaves = nodes.filter(d => !d.children || d.children.length === 0);

                leaves.each(function(d) {
                    const leaf = d3.select(this);
                    const threads = d.data.threadIds.map((id, i) => {
                        const name = d.data.threadNames[i] || 'Thread';
                        return id + ': ' + name;
                    });

                    const labelGroup = leaf.append('g')
                        .attr('class', 'node-thread-label-group')
                        .style('pointer-events', 'none')
                        .attr('transform', 'translate(0, ' + flipTopDown(-nodeHeight / 2 - 10) + ')');

                    // Render each thread label stacked vertically
                    threads.forEach((txt, i) => {
                        const yOffset = flipTopDown(-i * 15);
                        const text = labelGroup.append('text')
                            .attr('class', 'node-thread-label-text')
                            .classed('current-thread', d.data.threadIds[i] === currentThreadId)
                            .attr('text-anchor', 'middle')
                            .attr('y', yOffset)
                            .text(txt);

                        // Add background rect for readability
                        const node = text.node();
                        if (node) {
                            const bbox = node.getBBox();
                            labelGroup.insert('rect', 'text')
                                .attr('class', 'node-thread-label-rect')
                                .classed('current-thread', d.data.threadIds[i] === currentThreadId)
                                .attr('x', bbox.x - 4)
                                .attr('y', bbox.y - 1)
                                .attr('width', bbox.width + 8)
                                .attr('height', bbox.height + 2);
                        }
                    });
                });

                // Thread Count Badge (if > 1)
                const badges = nodes.filter(d => d.data.threadIds && d.data.threadIds.length > 1);

                badges.append('circle')
                    .attr('class', 'node-thread-badge')
                    .attr('cx', nodeWidth/2)
                    .attr('cy', -nodeHeight/2)
                    .attr('r', 12)
                    .style("pointer-events", "all")
                    .on("mouseover", function(event, d) {
                         event.stopPropagation();
                         cancelHideTooltip();

                         const isSplitNode = d.data.id.includes('::split::');

                         let html = '';
                         if (isSplitNode) {
                             html = '<strong>Split Node</strong><br/>Thread: ' + d.data.threadIds.join(', ') + '<br/>';
                             html += '<button id="merge-btn">Merge</button>';
                         } else {
                             html = '<strong>Threads: ' + d.data.threadIds.length + '</strong><br/>';
                             html += '<div style="max-height: 100px; overflow-y: auto;">' + d.data.threadIds.join(', ') + '</div>';
                             html += '<button id="split-btn">Split</button>';
                         }

                         showTooltip(html, event.pageX + 10, event.pageY - 10);

                         if (isSplitNode) {
                            const btn = document.getElementById('merge-btn');
                            if(btn) btn.onclick = () => mergeNode(d.data.id);
                         } else {
                            const btn = document.getElementById('split-btn');
                            if(btn) btn.onclick = () => splitNode(d.data.id);
                         }
                    })
                    .on("mouseout", hideTooltipWithDelay);

                badges.append('text')
                    .attr('class', 'node-thread-count')
                    .attr('x', nodeWidth/2)
                    .attr('y', -nodeHeight/2)
                    .attr('dy', '0.35em')
                    .attr('text-anchor', 'middle')
                    .text(d => d.data.threadIds.length);
            }

            // --- Global Helpers ---

            let hideTimeout;

            function showTooltip(html, x, y) {
                if (hideTimeout) clearTimeout(hideTimeout);
                const tooltip = d3.select("#tooltip");
                tooltip.style("opacity", 1)
                       .style("left", x + "px")
                       .style("top", y + "px")
                       .style("display", "block")
                       .html(html);
            }

            function hideTooltipWithDelay() {
                if (hideTimeout) clearTimeout(hideTimeout);
                hideTimeout = setTimeout(() => {
                    d3.select("#tooltip")
                        .style("opacity", 0)
                        .style("display", "none");
                }, 500);
            }

            function cancelHideTooltip() {
                if (hideTimeout) clearTimeout(hideTimeout);
            }

            d3.select("#tooltip")
                .on("mouseover", cancelHideTooltip)
                .on("mouseout", hideTooltipWithDelay);

            // Global mouseout to close tooltip triggers hide logic
            document.addEventListener('mouseover', function(e) {
                 const target = e.target;
                 const onTooltip = target.closest('.tooltip');
                 const onBadge = target.closest('.node-thread-badge');

                 if (!onTooltip && !onBadge) {
                     // rely on mouseout timeout
                 }
            });

            // Interaction Functions
            window.splitNode = function(nodeId) {
                if (!splitNodeIds.includes(nodeId)) {
                    splitNodeIds.push(nodeId);
                    vscode.postMessage({ command: 'refresh', splitNodes: splitNodeIds });
                }
            };

            window.mergeNode = function(nodeId) {
                const parts = nodeId.split('::split::');
                if (parts.length > 0) {
                    const canonicalId = parts[0];
                    const index = splitNodeIds.indexOf(canonicalId);
                    if (index > -1) {
                        splitNodeIds.splice(index, 1);
                        vscode.postMessage({ command: 'refresh', splitNodes: splitNodeIds });
                    }
                }
            };

            // Initial refresh
            vscode.postMessage({ command: 'refresh', splitNodes: splitNodeIds });
        </script>
    </body>
    </html>`;
    }
}
