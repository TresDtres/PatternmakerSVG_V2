import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

type Point = { x: number; y: number };
type NodeType = 'corner' | 'smooth';

type Node = {
    anchor: Point;
    ctrl1: Point;
    ctrl2: Point;
    type: NodeType;
};

type HistoryState = {
    nodes: Node[];
    isPathClosed: boolean;
};

type ViewState = {
    zoom: number;
    pan: Point;
};

const SMOOTHING_FACTOR = 0.25;
const INSERT_THRESHOLD = 10;
const DRAG_THRESHOLD = 3;
const SNAP_GRID_SIZE = 10;
const CANVAS_WIDTH = 4000;
const CANVAS_HEIGHT = 4000;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 10;

const translations = {
  en: {
    title: "Bézier Curve Editor",
    instructions: "Mouse wheel: Zoom. Space + Drag: Pan. Ctrl+Click: Smooth point. Del/Backspace: Delete node.",
    undo: "Undo",
    redo: "Redo",
    closePath: "Close Path",
    snapToGrid: "Snap to Grid",
    deleteNode: "Delete Node",
    clearCanvas: "Clear Canvas",
    exportSVG: "Export to SVG",
    language: "Español",
    applySymmetry: "Apply Symmetry",
    cancelSymmetry: "Cancel",
    pickEdgePrompt: "Click a straight edge to apply symmetry.",
    notStraightEdgeError: "Symmetry can only be applied to a straight edge."
  },
  es: {
    title: "Editor de Curvas Bézier",
    instructions: "Rueda del ratón: Zoom. Espacio + Arrastrar: Mover. Ctrl+Click: Punto suave. Supr/Retroceso: Borrar nodo.",
    undo: "Deshacer",
    redo: "Rehacer",
    closePath: "Cerrar Trazado",
    snapToGrid: "Ajustar a la Rejilla",
    deleteNode: "Borrar Nodo",
    clearCanvas: "Borrar Lienzo",
    exportSVG: "Exportar a SVG",
    language: "English",
    applySymmetry: "Aplicar Simetría",
    cancelSymmetry: "Cancelar",
    pickEdgePrompt: "Haz clic en una arista recta para aplicar la simetría.",
    notStraightEdgeError: "La simetría solo se puede aplicar a una arista recta."
  }
};


// Helper to calculate a point on a cubic Bézier curve.
const getPointOnCubicBezier = (t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point => {
    const u = 1 - t;
    const tt = t * t;
    const uu = u * u;
    const uuu = uu * u;
    const ttt = tt * t;

    const p = { x: 0, y: 0 };
    p.x = uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x;
    p.y = uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y;

    return p;
};

// Finds the closest point on a Bézier curve by sampling points.
const findClosestPointOnCubicBezier = (point: Point, p0: Point, p1: Point, p2: Point, p3: Point): { distance: number; t: number; } => {
    let minDistanceSq = Infinity;
    let bestT = 0;
    const steps = 30; // Sample points along the curve for accuracy

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const pt = getPointOnCubicBezier(t, p0, p1, p2, p3);
        const distSq = Math.pow(pt.x - point.x, 2) + Math.pow(pt.y - point.y, 2);
        if (distSq < minDistanceSq) {
            minDistanceSq = distSq;
            bestT = t;
        }
    }
    
    return { distance: Math.sqrt(minDistanceSq), t: bestT };
};

const GridLines = React.memo(({ width, height, zoom }: { width: number, height: number, zoom: number }) => {
    const lines = [];
    
    let majorGridSize = 100;
    while (majorGridSize * zoom < 60) {
        majorGridSize *= 5;
    }
    while (majorGridSize * zoom > 300) {
        majorGridSize /= 5;
    }
    const minorGridSize = majorGridSize / 5;

    for (let x = 0; x <= width; x += minorGridSize) {
        if (x % majorGridSize === 0) {
             lines.push(<line key={`v-maj-${x}`} x1={x} y1={0} x2={x} y2={height} className="grid-line-major" />);
        } else {
             lines.push(<line key={`v-min-${x}`} x1={x} y1={0} x2={x} y2={height} className="grid-line-minor" />);
        }
    }

    for (let y = 0; y <= height; y += minorGridSize) {
       if (y % majorGridSize === 0) {
            lines.push(<line key={`h-maj-${y}`} x1={0} y1={y} x2={width} y2={y} className="grid-line-major" />);
       } else {
            lines.push(<line key={`h-min-${y}`} x1={0} y1={y} x2={width} y2={y} className="grid-line-minor" />);
       }
    }
    return <g>{lines}</g>;
});


const App = () => {
    const [nodes, setNodes] = useState<Node[]>([]);
    const [isPathClosed, setIsPathClosed] = useState(false);
    const [draggedInfo, setDraggedInfo] = useState<{ index: number; type: 'anchor' | 'ctrl1' | 'ctrl2' } | null>(null);
    const [selectedNodeIndex, setSelectedNodeIndex] = useState<number | null>(null);
    const [isSnapEnabled, setIsSnapEnabled] = useState(false);
    const [viewState, setViewState] = useState<ViewState>({ zoom: 0.25, pan: { x: 0, y: 0 } });
    const [isPanning, setIsPanning] = useState(false);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [language, setLanguage] = useState<'en' | 'es'>('es');
    const [symmetryState, setSymmetryState] = useState<'inactive' | 'picking-edge'>('inactive');

    const svgRef = useRef<SVGSVGElement>(null);
    const wasDragging = useRef(false);
    const mouseDownPos = useRef<Point | null>(null);
    const panStartPos = useRef<Point | null>(null);

    const [history, setHistory] = useState<HistoryState[]>([{ nodes: [], isPathClosed: false }]);
    const [historyIndex, setHistoryIndex] = useState(0);

    const t = useCallback((key: keyof typeof translations.en) => {
        return translations[language][key] || key;
    }, [language]);


    useEffect(() => {
        if (svgRef.current) {
            const { clientWidth, clientHeight } = svgRef.current;
            setViewState(vs => ({
                ...vs,
                pan: {
                    x: (clientWidth - CANVAS_WIDTH * vs.zoom) / 2,
                    y: (clientHeight - CANVAS_HEIGHT * vs.zoom) / 2
                }
            }));
        }
    }, []);

    const updateStateAndHistory = useCallback((newNodes: Node[], newIsPathClosed: boolean) => {
        setNodes(newNodes);
        setIsPathClosed(newIsPathClosed);

        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push({ nodes: newNodes, isPathClosed: newIsPathClosed });
        setHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);
    }, [history, historyIndex]);

    const getSVGCoordinates = useCallback((event: React.MouseEvent | React.TouchEvent | MouseEvent | TouchEvent): Point | null => {
        if (!svgRef.current) return null;
        const svg = svgRef.current;
        const rect = svg.getBoundingClientRect();

        let clientX, clientY;
        if ('touches' in event && event.touches.length > 0) {
            clientX = event.touches[0].clientX;
            clientY = event.touches[0].clientY;
        } else if ('changedTouches' in event && event.changedTouches.length > 0) {
            clientX = event.changedTouches[0].clientX;
            clientY = event.changedTouches[0].clientY;
        } else if ('clientX' in event) {
            clientX = event.clientX;
            clientY = event.clientY;
        } else {
            return null;
        }

        const svgX = clientX - rect.left;
        const svgY = clientY - rect.top;

        const worldX = (svgX - viewState.pan.x) / viewState.zoom;
        const worldY = (svgY - viewState.pan.y) / viewState.zoom;

        return { x: worldX, y: worldY };
    }, [viewState.pan, viewState.zoom]);

    const snap = useCallback((value: number) => {
        return isSnapEnabled ? Math.round(value / SNAP_GRID_SIZE) * SNAP_GRID_SIZE : value;
    }, [isSnapEnabled]);
    
    const handleSymmetryEdgePick = useCallback((point: Point) => {
        if (!isPathClosed || nodes.length < 3) {
            setSymmetryState('inactive');
            return;
        }

        let closestEdgeIndex = -1;
        let minDistance = Infinity;

        for (let i = 0; i < nodes.length; i++) {
            const p0 = nodes[i].anchor;
            const p3 = nodes[(i + 1) % nodes.length].anchor;
            const p1 = nodes[i].ctrl2;
            const p2 = nodes[(i + 1) % nodes.length].ctrl1;
            const { distance } = findClosestPointOnCubicBezier(point, p0, p1, p2, p3);
            if (distance < minDistance) {
                minDistance = distance;
                closestEdgeIndex = i;
            }
        }

        if (closestEdgeIndex === -1) {
            setSymmetryState('inactive');
            return;
        }

        const axisNode1Index = closestEdgeIndex; // Node A
        const axisNode2Index = (closestEdgeIndex + 1) % nodes.length; // Node B
        const pA = nodes[axisNode1Index].anchor;
        const pB = nodes[axisNode2Index].anchor;
        const ctrlA = nodes[axisNode1Index].ctrl2;
        const ctrlB = nodes[axisNode2Index].ctrl1;

        const isStraight =
            Math.abs((pB.x - pA.x) * (ctrlA.y - pA.y) - (pB.y - pA.y) * (ctrlA.x - pA.x)) < 1e-3 &&
            Math.abs((pB.x - pA.x) * (ctrlB.y - pA.y) - (pB.y - pA.y) * (ctrlB.x - pA.x)) < 1e-3;

        if (!isStraight) {
            alert(t('notStraightEdgeError'));
            setSymmetryState('inactive');
            return;
        }

        // Reflection logic
        const A_coeff = pB.y - pA.y;
        const B_coeff = pA.x - pB.x;
        const C_coeff = pB.x * pA.y - pB.y * pA.x;
        const D_coeff = A_coeff * A_coeff + B_coeff * B_coeff;

        const reflectPoint = (p: Point): Point => {
            if (D_coeff === 0) return { ...p };
            const val = A_coeff * p.x + B_coeff * p.y + C_coeff;
            return {
                x: p.x - 2 * A_coeff * val / D_coeff,
                y: p.y - 2 * B_coeff * val / D_coeff
            };
        };

        const reflectNode = (node: Node): Node => ({
            anchor: reflectPoint(node.anchor),
            ctrl1: reflectPoint(node.ctrl1),
            ctrl2: reflectPoint(node.ctrl2),
            type: node.type
        });

        // Collect the nodes forming the "body" of the shape, from B around to A.
        const bodyPath = [];
        let currentIndex = axisNode2Index;
        while (currentIndex !== axisNode1Index) {
            bodyPath.push(nodes[currentIndex]);
            currentIndex = (currentIndex + 1) % nodes.length;
        }
        bodyPath.push(nodes[axisNode1Index]);
        
        // Isolate intermediate nodes (the body, excluding axis nodes A and B) for mirroring.
        const intermediateNodes = bodyPath.slice(1, bodyPath.length - 1).map(n => ({...n}));

        const mirroredIntermediateNodes = intermediateNodes
            .map(reflectNode)
            .reverse()
            .map(node => ({
                ...node,
                ctrl1: node.ctrl2, // Swap handles for reversed path direction
                ctrl2: node.ctrl1,
            }));

        // Get copies of axis nodes to modify for the seam.
        const newA = { ...nodes[axisNode1Index] };
        const newB = { ...nodes[axisNode2Index] };

        // Make the seam smooth by reflecting the control handles that point into the body.
        newA.ctrl2 = reflectPoint(newA.ctrl1); // ctrl1 points from the last body node.
        newB.ctrl1 = reflectPoint(newB.ctrl2); // ctrl2 points to the first body node.
        newA.type = 'smooth';
        newB.type = 'smooth';

        // Build the new symmetrical, closed path.
        // The path order is: A -> reflected body -> B -> original body -> (closed to) A.
        const combinedNodes = [
            newA,
            ...mirroredIntermediateNodes,
            newB,
            ...intermediateNodes,
        ];

        updateStateAndHistory(combinedNodes, true);
        setSymmetryState('inactive');
    }, [nodes, isPathClosed, t, updateStateAndHistory]);

    const handleMouseDown = useCallback((event: React.MouseEvent<SVGSVGElement>) => {
        event.preventDefault();

        if (isSpacePressed) {
            setIsPanning(true);
            panStartPos.current = { x: event.clientX, y: event.clientY };
            return;
        }
        
        const point = getSVGCoordinates(event);
        if (!point) return;

        mouseDownPos.current = point;
        wasDragging.current = false;

        if (symmetryState === 'picking-edge') {
            handleSymmetryEdgePick(point);
            // By setting wasDragging to true, we prevent handleMouseUp from
            // thinking this was a simple click and adding an unwanted new node.
            wasDragging.current = true;
            return;
        }

        // Check if clicking on an anchor or control point
        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            const anchorDist = Math.hypot(point.x - node.anchor.x, point.y - node.anchor.y);
            
            if (anchorDist < 10 / viewState.zoom) {
                setDraggedInfo({ index: i, type: 'anchor' });
                setSelectedNodeIndex(i);
                return;
            }

            if (isPathClosed) {
                const ctrl1Dist = Math.hypot(point.x - node.ctrl1.x, point.y - node.ctrl1.y);
                const ctrl2Dist = Math.hypot(point.x - node.ctrl2.x, point.y - node.ctrl2.y);
                if (ctrl1Dist < 8 / viewState.zoom) {
                    setDraggedInfo({ index: i, type: 'ctrl1' });
                    setSelectedNodeIndex(i);
                    return;
                }
                if (ctrl2Dist < 8 / viewState.zoom) {
                    setDraggedInfo({ index: i, type: 'ctrl2' });
                    setSelectedNodeIndex(i);
                    return;
                }
            }
        }

        // Logic to insert a node on the path
        if (nodes.length > 0) {
            let bestInsertPos = null;
            let minDistance = INSERT_THRESHOLD / viewState.zoom;

            for (let i = 0; i < (isPathClosed ? nodes.length : nodes.length - 1); i++) {
                const p0 = nodes[i].anchor;
                const p1 = nodes[i].ctrl2;
                const p2 = nodes[(i + 1) % nodes.length].ctrl1;
                const p3 = nodes[(i + 1) % nodes.length].anchor;

                const { distance, t } = findClosestPointOnCubicBezier(point, p0, p1, p2, p3);

                if (distance < minDistance) {
                    minDistance = distance;
                    bestInsertPos = { index: i, t };
                }
            }

            if (bestInsertPos) {
                const { index, t } = bestInsertPos;
                const p0 = nodes[index].anchor;
                const p1 = nodes[index].ctrl2;
                const p2 = nodes[(index + 1) % nodes.length].ctrl1;
                const p3 = nodes[(index + 1) % nodes.length].anchor;

                // De Casteljau's algorithm to split the curve
                const p01 = { x: (1 - t) * p0.x + t * p1.x, y: (1 - t) * p0.y + t * p1.y };
                const p12 = { x: (1 - t) * p1.x + t * p2.x, y: (1 - t) * p1.y + t * p2.y };
                const p23 = { x: (1 - t) * p2.x + t * p3.x, y: (1 - t) * p2.y + t * p3.y };
                const p012 = { x: (1 - t) * p01.x + t * p12.x, y: (1 - t) * p01.y + t * p12.y };
                const p123 = { x: (1 - t) * p12.x + t * p23.x, y: (1 - t) * p12.y + t * p23.y };
                const newAnchor = { x: (1 - t) * p012.x + t * p123.x, y: (1 - t) * p012.y + t * p123.y };

                const newNode: Node = {
                    anchor: newAnchor,
                    ctrl1: p012,
                    ctrl2: p123,
                    type: 'smooth'
                };
                
                const newNodes = [...nodes];
                newNodes[index].ctrl2 = p01;
                newNodes[(index + 1) % nodes.length].ctrl1 = p23;
                newNodes.splice(index + 1, 0, newNode);
                
                updateStateAndHistory(newNodes, isPathClosed);
                setSelectedNodeIndex(index + 1);
                setDraggedInfo({ index: index + 1, type: 'anchor' });
                return;
            }
        }
        setDraggedInfo(null);
        setSelectedNodeIndex(null);
    }, [nodes, isPathClosed, viewState.zoom, getSVGCoordinates, updateStateAndHistory, symmetryState, handleSymmetryEdgePick, isSpacePressed]);

    const handleMouseMove = useCallback((event: React.MouseEvent<SVGSVGElement>) => {
        if (isPanning && panStartPos.current) {
            const dx = event.clientX - panStartPos.current.x;
            const dy = event.clientY - panStartPos.current.y;
            setViewState(vs => ({ ...vs, pan: { x: vs.pan.x + dx, y: vs.pan.y + dy } }));
            panStartPos.current = { x: event.clientX, y: event.clientY };
            return;
        }
        
        if (!mouseDownPos.current) return;
        const point = getSVGCoordinates(event);
        if (!point) return;

        const dist = Math.hypot(point.x - mouseDownPos.current.x, point.y - mouseDownPos.current.y);
        if (dist > DRAG_THRESHOLD / viewState.zoom) {
            wasDragging.current = true;
        }

        if (!draggedInfo) return;

        const { index, type } = draggedInfo;
        const newNodes = [...nodes];
        const node = { ...newNodes[index] };
        const snappedPoint = { x: snap(point.x), y: snap(point.y) };

        if (type === 'anchor') {
            const dx = snappedPoint.x - node.anchor.x;
            const dy = snappedPoint.y - node.anchor.y;
            node.anchor = snappedPoint;
            node.ctrl1 = { x: node.ctrl1.x + dx, y: node.ctrl1.y + dy };
            node.ctrl2 = { x: node.ctrl2.x + dx, y: node.ctrl2.y + dy };
        } else if (type === 'ctrl1') {
            node.ctrl1 = snappedPoint;
            if (node.type === 'smooth') {
                const d = Math.hypot(node.anchor.x - snappedPoint.x, node.anchor.y - snappedPoint.y);
                const angle = Math.atan2(node.anchor.y - snappedPoint.y, node.anchor.x - snappedPoint.x);
                const d2 = Math.hypot(node.anchor.x - node.ctrl2.x, node.anchor.y - node.ctrl2.y);
                node.ctrl2 = { x: node.anchor.x + d2 * Math.cos(angle), y: node.anchor.y + d2 * Math.sin(angle) };
            }
        } else if (type === 'ctrl2') {
            node.ctrl2 = snappedPoint;
            if (node.type === 'smooth') {
                const d = Math.hypot(node.anchor.x - snappedPoint.x, node.anchor.y - snappedPoint.y);
                const angle = Math.atan2(node.anchor.y - snappedPoint.y, node.anchor.x - snappedPoint.x);
                const d1 = Math.hypot(node.anchor.x - node.ctrl1.x, node.anchor.y - node.ctrl1.y);
                node.ctrl1 = { x: node.anchor.x + d1 * Math.cos(angle), y: node.anchor.y + d1 * Math.sin(angle) };
            }
        }
        newNodes[index] = node;
        setNodes(newNodes);

    }, [draggedInfo, getSVGCoordinates, isPanning, nodes, snap, viewState.zoom]);

    const handleMouseUp = useCallback((event: React.MouseEvent<SVGSVGElement>) => {
        if (isPanning) {
            setIsPanning(false);
            panStartPos.current = null;
        }
        
        const point = getSVGCoordinates(event);
        if (!point) return;

        if (draggedInfo) {
            updateStateAndHistory(nodes, isPathClosed);
        } else if (!wasDragging.current && !event.ctrlKey && !isSpacePressed) {
            const snappedPoint = { x: snap(point.x), y: snap(point.y) };
            const newNode: Node = {
                anchor: snappedPoint,
                ctrl1: { x: snappedPoint.x - 50, y: snappedPoint.y },
                ctrl2: { x: snappedPoint.x + 50, y: snappedPoint.y },
                type: 'corner',
            };

            let newNodes = [...nodes];
            if (newNodes.length > 0) {
                const prevNode = newNodes[newNodes.length - 1];
                const dx = newNode.anchor.x - prevNode.anchor.x;
                const dy = newNode.anchor.y - prevNode.anchor.y;
                const angle = Math.atan2(dy, dx);
                const dist = Math.hypot(dx, dy) * SMOOTHING_FACTOR;
                const updatedPrevNode = { ...prevNode, ctrl2: { x: prevNode.anchor.x + dist * Math.cos(angle), y: prevNode.anchor.y + dist * Math.sin(angle) } };
                newNode.ctrl1 = { x: newNode.anchor.x - dist * Math.cos(angle), y: newNode.anchor.y - dist * Math.sin(angle) };
                newNodes[newNodes.length - 1] = updatedPrevNode;
            }

            newNodes = [...newNodes, newNode];
            updateStateAndHistory(newNodes, isPathClosed);
            setSelectedNodeIndex(newNodes.length - 1);
        }

        setDraggedInfo(null);
        mouseDownPos.current = null;
    }, [draggedInfo, getSVGCoordinates, isPanning, nodes, isPathClosed, snap, updateStateAndHistory, isSpacePressed]);
    
    const handleMouseLeave = useCallback(() => {
        if(draggedInfo) {
            updateStateAndHistory(nodes, isPathClosed);
        }
        setDraggedInfo(null);
        mouseDownPos.current = null;
        setIsPanning(false);
        panStartPos.current = null;
    }, [draggedInfo, nodes, isPathClosed, updateStateAndHistory]);

    const handleWheel = useCallback((event: React.WheelEvent<SVGSVGElement>) => {
        event.preventDefault();
        if (!svgRef.current) return;
        const rect = svgRef.current.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;

        const zoomFactor = 1.1;
        const newZoom = event.deltaY < 0 ? viewState.zoom * zoomFactor : viewState.zoom / zoomFactor;
        const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
        
        if (clampedZoom === viewState.zoom) return;

        const newPanX = mouseX - (mouseX - viewState.pan.x) * (clampedZoom / viewState.zoom);
        const newPanY = mouseY - (mouseY - viewState.pan.y) * (clampedZoom / viewState.zoom);
        
        setViewState({ zoom: clampedZoom, pan: { x: newPanX, y: newPanY } });
    }, [viewState]);

    const undo = useCallback(() => {
        if (historyIndex > 0) {
            const newIndex = historyIndex - 1;
            setHistoryIndex(newIndex);
            setNodes(history[newIndex].nodes);
            setIsPathClosed(history[newIndex].isPathClosed);
        }
    }, [history, historyIndex]);

    const redo = useCallback(() => {
        if (historyIndex < history.length - 1) {
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            setNodes(history[newIndex].nodes);
            setIsPathClosed(history[newIndex].isPathClosed);
        }
    }, [history, historyIndex]);

    const deleteSelectedNode = useCallback(() => {
        if (selectedNodeIndex !== null) {
            const newNodes = nodes.filter((_, i) => i !== selectedNodeIndex);
            updateStateAndHistory(newNodes, newNodes.length < 3 ? false : isPathClosed);
            setSelectedNodeIndex(null);
        }
    }, [selectedNodeIndex, nodes, isPathClosed, updateStateAndHistory]);

    const handleKeyDown = useCallback((event: KeyboardEvent) => {
        if (event.key === ' ' && !isSpacePressed) {
            event.preventDefault();
            setIsSpacePressed(true);
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
            deleteSelectedNode();
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'z') {
            event.preventDefault();
            undo();
        }
        if ((event.ctrlKey || event.metaKey) && event.key === 'y') {
            event.preventDefault();
            redo();
        }
    }, [isSpacePressed, deleteSelectedNode, undo, redo]);

    const handleKeyUp = useCallback((event: KeyboardEvent) => {
        if (event.key === ' ') {
            setIsSpacePressed(false);
            setIsPanning(false);
        }
    }, []);
    
    const handleContextMenu = useCallback((event: React.MouseEvent) => {
        event.preventDefault();
    }, []);

    useEffect(() => {
        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, [handleKeyDown, handleKeyUp]);

    const toggleClosePath = () => {
        let newNodes = [...nodes];
        const newIsPathClosed = !isPathClosed;

        // When closing the path, auto-smooth the connection
        if (newIsPathClosed && newNodes.length >= 2) {
            const firstNode = newNodes[0];
            const lastNode = newNodes[newNodes.length - 1];

            const dx = firstNode.anchor.x - lastNode.anchor.x;
            const dy = firstNode.anchor.y - lastNode.anchor.y;
            const angle = Math.atan2(dy, dx);
            const dist = Math.hypot(dx, dy) * SMOOTHING_FACTOR;

            const updatedLastNode = { ...lastNode, ctrl2: { x: lastNode.anchor.x + dist * Math.cos(angle), y: lastNode.anchor.y + dist * Math.sin(angle) } };
            const updatedFirstNode = { ...firstNode, ctrl1: { x: firstNode.anchor.x - dist * Math.cos(angle), y: firstNode.anchor.y - dist * Math.sin(angle) } };
            
            newNodes[0] = updatedFirstNode;
            newNodes[newNodes.length - 1] = updatedLastNode;
        }
        
        updateStateAndHistory(newNodes, newIsPathClosed);
    };

    const toggleSnap = () => {
        setIsSnapEnabled(!isSnapEnabled);
    };
    
    const toggleLanguage = () => {
        setLanguage(lang => lang === 'en' ? 'es' : 'en');
    };

    const clearCanvas = () => {
        updateStateAndHistory([], false);
        setSelectedNodeIndex(null);
    };

    const exportSVG = () => {
        if (!svgRef.current) return;
        const pathData = generatePathData(nodes, isPathClosed);
        const svgContent = `<svg width="4000" height="4000" viewBox="0 0 4000 4000" xmlns="http://www.w3.org/2000/svg">
  <path d="${pathData}" stroke="black" fill="${isPathClosed ? 'rgba(0,0,0,0.1)' : 'none'}" stroke-width="2"/>
</svg>`;
        const blob = new Blob([svgContent], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'bezier-creation.svg';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };
    
    const toggleApplySymmetry = () => {
        if (symmetryState === 'inactive') {
            setSymmetryState('picking-edge');
            setSelectedNodeIndex(null);
        } else {
            setSymmetryState('inactive');
        }
    };

    const generatePathData = (pathNodes: Node[], closed: boolean) => {
        if (pathNodes.length === 0) return "";
        let d = `M ${pathNodes[0].anchor.x} ${pathNodes[0].anchor.y}`;
        for (let i = 0; i < (closed ? pathNodes.length : pathNodes.length - 1); i++) {
            const node1 = pathNodes[i];
            const node2 = pathNodes[(i + 1) % pathNodes.length];
            d += ` C ${node1.ctrl2.x} ${node1.ctrl2.y}, ${node2.ctrl1.x} ${node2.ctrl1.y}, ${node2.anchor.x} ${node2.anchor.y}`;
        }
        if (closed) {
            d += " Z";
        }
        return d;
    };
    
    const pathData = useMemo(() => generatePathData(nodes, isPathClosed), [nodes, isPathClosed]);

    return (
        <div className="app-container">
            <h1>{t('title')}</h1>
            <p>{symmetryState === 'picking-edge' ? t('pickEdgePrompt') : t('instructions')}</p>
            <div className="toolbar">
                <div className="toolbar-group">
                    <button onClick={undo} disabled={historyIndex === 0}>{t('undo')}</button>
                    <button onClick={redo} disabled={historyIndex === history.length - 1}>{t('redo')}</button>
                </div>
                 <button onClick={toggleClosePath} disabled={nodes.length < 3}>{t('closePath')}</button>
                 <button onClick={toggleApplySymmetry} className={symmetryState === 'picking-edge' ? 'active' : ''} disabled={nodes.length < 3 || !isPathClosed}>
                    {symmetryState === 'picking-edge' ? t('cancelSymmetry') : t('applySymmetry')}
                </button>
                <button onClick={toggleSnap} className={isSnapEnabled ? 'active' : ''}>{t('snapToGrid')}</button>
                <button onClick={deleteSelectedNode} disabled={selectedNodeIndex === null}>{t('deleteNode')}</button>
                <button onClick={clearCanvas}>{t('clearCanvas')}</button>
                <button onClick={exportSVG} disabled={nodes.length === 0}>{t('exportSVG')}</button>
                 <button onClick={toggleLanguage}>{t('language')}</button>
            </div>
            <svg
                ref={svgRef}
                className={`drawing-canvas ${isPanning || isSpacePressed ? 'panning' : ''} ${symmetryState === 'picking-edge' ? 'picking-symmetry' : ''}`}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
                onWheel={handleWheel}
                onContextMenu={handleContextMenu}
            >
                <g transform={`translate(${viewState.pan.x}, ${viewState.pan.y}) scale(${viewState.zoom})`}>
                    <rect x="0" y="0" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="transparent" />
                    
                    {isSnapEnabled && <GridLines width={CANVAS_WIDTH} height={CANVAS_HEIGHT} zoom={viewState.zoom} />}
                    
                    <line x1={CANVAS_WIDTH / 2} y1="0" x2={CANVAS_WIDTH / 2} y2={CANVAS_HEIGHT} className="center-axis-guide" />
                    <line x1="0" y1={CANVAS_HEIGHT / 2} x2={CANVAS_WIDTH} y2={CANVAS_HEIGHT / 2} className="center-axis-guide" />

                    <path
                        className={`current-path ${isPathClosed ? 'closed-path' : 'open-path'}`}
                        d={pathData}
                        strokeWidth={2 / viewState.zoom}
                    />

                    {symmetryState !== 'picking-edge' && <g className="controls">
                        {nodes.map((node, i) => (
                            <React.Fragment key={i}>
                                {isPathClosed && (
                                    <>
                                        <line
                                            className="control-line"
                                            x1={node.anchor.x}
                                            y1={node.anchor.y}
                                            x2={node.ctrl1.x}
                                            y2={node.ctrl1.y}
                                            strokeWidth={1.5 / viewState.zoom}
                                        />
                                        <line
                                            className="control-line"
                                            x1={node.anchor.x}
                                            y1={node.anchor.y}
                                            x2={node.ctrl2.x}
                                            y2={node.ctrl2.y}
                                            strokeWidth={1.5 / viewState.zoom}
                                        />
                                        <circle
                                            className="control-point"
                                            cx={node.ctrl1.x}
                                            cy={node.ctrl1.y}
                                            r={6 / viewState.zoom}
                                            strokeWidth={1.5 / viewState.zoom}
                                        />
                                        <circle
                                            className="control-point"
                                            cx={node.ctrl2.x}
                                            cy={node.ctrl2.y}
                                            r={6 / viewState.zoom}
                                            strokeWidth={1.5 / viewState.zoom}
                                        />
                                    </>
                                )}
                                {node.type === 'corner' ?
                                    <rect
                                        className={`anchor-point corner ${selectedNodeIndex === i ? 'selected' : ''}`}
                                        x={node.anchor.x - 7 / viewState.zoom}
                                        y={node.anchor.y - 7 / viewState.zoom}
                                        width={14 / viewState.zoom}
                                        height={14 / viewState.zoom}
                                    /> :
                                    <circle
                                        className={`anchor-point smooth ${selectedNodeIndex === i ? 'selected' : ''}`}
                                        cx={node.anchor.x}
                                        cy={node.anchor.y}
                                        r={8 / viewState.zoom}
                                        strokeWidth={2 / viewState.zoom}
                                    />
                                }
                            </React.Fragment>
                        ))}
                    </g>}
                </g>
            </svg>
        </div>
    );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);