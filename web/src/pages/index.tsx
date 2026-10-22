export const pageConfig = () => ({
  title: '欧享家 · 本地控制台',
});
import { useEffect, useState, useCallback, useRef } from 'react';
import styles from './index.module.css';

/**
 * 几何模型 V3（3D 完整空间语义，全部为房间尺寸百分比 0-100）：
 * 房间：{ w, h, depth } —— 宽/高/深（h 为高度，决定房间盒子比例）
 * - 吸顶灯（圆盘面光源）：{ kind: 'circle', x, y, r, elev } —— x/y 平面位置、r 半径、elev 悬吊高度（0=地，100=天花）
 * - 灯带（长条）：{ kind: 'segment', x1, y1, x2, y2, elev } —— 平面走向 + elev 安装高度（踢脚线≈10，顶棚≈95）
 * - 网关/插座：{ kind: 'point', x, y, elev } —— elev≈0 地面，≈30 墙面
 */
interface CirclePos { kind: 'circle'; x: number; y: number; r: number; elev?: number; name?: string }
interface SegmentPos { kind: 'segment'; x1: number; y1: number; x2: number; y2: number; elev?: number; name?: string }
interface PointPos { kind: 'point'; x: number; y: number; elev?: number; name?: string }
type Pos = CirclePos | SegmentPos | PointPos;

interface RoomShape { w: number; h: number; depth: number }

interface Device {
  vDeviceId: string;
  name: string;
  type: string | null;
  protocol: string | null;
  online: boolean;
  parent: string | null;
  position: Pos | null;
}

interface Room {
  gpno: number;
  name: string;
  deviceCount: number | null;
  shape: RoomShape;
  devices: Device[];
}

interface Home {
  projectCode: string;
  name: string;
  deviceCount: number;
  onlineCount: number | null;
  rooms: Room[];
}

const API = '/api';

function isStrip(d: Device): boolean {
  return /灯带|带|精灵/.test(`${d.name}${d.type ?? ''}`);
}
function isCeiling(d: Device): boolean {
  return /吸顶灯|客厅灯|主灯/.test(`${d.name}${d.type ?? ''}`);
}

// 默认布局：灯带贴四面墙 elev=10，吸顶灯居中 elev=95，网关 elev=0
const WALLS = [
  { x1: 10, y1: 15, x2: 10, y2: 85 },
  { x1: 90, y1: 15, x2: 90, y2: 85 },
  { x1: 15, y1: 10, x2: 85, y2: 10 },
  { x1: 15, y1: 90, x2: 85, y2: 90 },
];

function defaultPos(d: Device, i: number, devices: Device[]): Pos {
  if (isStrip(d)) {
    const stripsBefore = devices.slice(0, i).filter(isStrip).length;
    return { kind: 'segment', ...WALLS[stripsBefore % WALLS.length], elev: 10 };
  }
  if (isCeiling(d)) {
    const ceilings = devices.map((x, idx) => (isCeiling(x) ? idx : -1)).filter((v) => v >= 0);
    const ci = ceilings.indexOf(i);
    const total = ceilings.length;
    const y = total === 1 ? 50 : 25 + (ci * 50) / (total - 1);
    return { kind: 'circle', x: 50, y, r: 8, elev: 95 };
  }
  const points = devices.map((x, idx) => (!isStrip(x) && !isCeiling(x) ? idx : -1)).filter((v) => v >= 0);
  const pi = points.indexOf(i);
  const total = points.length;
  if (total <= 0) return { kind: 'point', x: 50, y: 50, elev: 0 };
  const cols = Math.min(total, 3);
  const col = pi % cols;
  const row = Math.floor(pi / cols);
  return {
    kind: 'point',
    x: cols === 1 ? 50 : (col * 100) / (cols - 1) * 0.5 + 25,
    y: row === 0 ? 85 : 95,
    elev: 0,
  };
}

// 旧数据兼容升级（无 kind / 无 elev）
function upgradePos(d: Device, raw: any): Pos | null {
  if (!raw) return null;
  if (raw.kind === 'circle' || raw.kind === 'segment' || raw.kind === 'point') {
    if (raw.kind === 'circle' && !raw.r) return { ...raw, r: 8 };
    if (raw.elev === undefined) {
      const elev = raw.kind === 'circle' ? 95 : raw.kind === 'segment' ? 10 : 0;
      return { ...raw, elev };
    }
    return raw;
  }
  if (raw.x !== undefined && raw.y !== undefined) {
    if (isCeiling(d)) return { kind: 'circle', x: raw.x, y: raw.y, r: 8, elev: 95 };
    if (isStrip(d)) return { kind: 'segment', x1: raw.x, y1: clamp(raw.y - 30), x2: raw.x, y2: clamp(raw.y + 30), elev: 10 };
    return { kind: 'point', x: raw.x, y: raw.y, elev: 0 };
  }
  return null;
}

const clamp = (v: number) => Math.round(Math.min(100, Math.max(0, v)));

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

// ---- 平面 SVG 视图 ----
const VW = 1000, VH = 400;
const sx = (x: number) => (x / 100) * VW;
const sy = (y: number) => (y / 100) * VH;
const sr = (r: number) => (r / 100) * VW;

function RoomMap({ room, projectCode, editMode, onSaved, onShapeSaved }: {
  room: Room;
  projectCode: string;
  editMode: boolean;
  onSaved: (gpno: number, positions: Record<string, Pos>) => void;
  onShapeSaved: (gpno: number, shape: RoomShape) => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [shape, setShape] = useState<RoomShape>(room.shape);
  const [dirty, setDirty] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ id: string; part: 'body' | 'p1' | 'p2' | 'resize'; grabPx: { x: number; y: number }; grabPos: Pos } | null>(null);

  useEffect(() => {
    setDevices(room.devices.map((d, i) => ({
      ...d,
      position: upgradePos(d, d.position) ?? defaultPos(d, i, room.devices),
    })));
    setShape(room.shape);
    setDirty(false);
  }, [room]);

  const toPct = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - rect.left) / rect.width) * 100),
      y: clamp(((e.clientY - rect.top) / rect.height) * 100),
    };
  };

  const onPointerDown = (e: React.PointerEvent, d: Device, part: 'body' | 'p1' | 'p2' | 'resize') => {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { id: d.vDeviceId, part, grabPx: toPct(e), grabPos: d.position! };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const ctx = drag.current;
    if (!ctx || !editMode) return;
    const p = toPct(e);
    const dx = p.x - ctx.grabPx.x;
    const dy = p.y - ctx.grabPx.y;
    setDevices((ds) => ds.map((d) => {
      if (d.vDeviceId !== ctx.id) return d;
      const g = ctx.grabPos;
      if (g.kind === 'point') {
        return { ...d, position: { ...g, x: clamp(g.x + dx), y: clamp(g.y + dy) } };
      }
      if (g.kind === 'circle') {
        if (ctx.part === 'resize') {
          const dist = Math.abs(p.x - g.x);
          return { ...d, position: { ...g, r: Math.max(3, Math.round(dist)) } };
        }
        return { ...d, position: { ...g, x: clamp(g.x + dx), y: clamp(g.y + dy) } };
      }
      if (ctx.part === 'p1') return { ...d, position: { ...g, x1: p.x, y1: p.y } };
      if (ctx.part === 'p2') return { ...d, position: { ...g, x2: p.x, y2: p.y } };
      const lenDx = g.x2 - g.x1, lenDy = g.y2 - g.y1;
      const nx1 = clamp(g.x1 + dx), ny1 = clamp(g.y1 + dy);
      return { ...d, position: { ...g, x1: nx1, y1: ny1, x2: clamp(nx1 + lenDx), y2: clamp(ny1 + lenDy) } };
    }));
    setDirty(true);
  };

  const onPointerUp = () => { drag.current = null; };

  const setElev = (id: string, elev: number) => {
    setDevices((ds) => ds.map((d) => {
      if (d.vDeviceId !== id) return d;
      return { ...d, position: d.position ? ({ ...d.position, elev } as Pos) : d.position };
    }));
    setDirty(true);
  };

  const save = async () => {
    const positions: Record<string, Pos> = {};
    for (const d of devices) if (d.position) positions[d.vDeviceId] = d.position;
    try {
      await api('/positions', {
        method: 'POST',
        body: JSON.stringify({ projectCode, gpno: room.gpno, shape, positions }),
      });
      setDirty(false);
      onSaved(room.gpno, positions);
      onShapeSaved(room.gpno, shape);
    } catch (e: any) {
      alert(`保存失败: ${e.message}`);
    }
  };

  const elevLabel = (e: number | undefined) => {
    if (e === undefined) return '';
    const meters = ((e / 100) * shape.h * 0.05).toFixed(1);
    return `离地 ${meters}m`;
  };

  return (
    <div className={styles.room}>
      <div className={styles.roomHeader}>
        <h2>🛏 {room.name} <span className={styles.roomCount}>{devices.length} 台 · {(shape.w * 0.05).toFixed(1)}m × {(shape.depth * 0.05).toFixed(1)}m × {(shape.h * 0.05).toFixed(1)}m</span></h2>
        {editMode && (
          <button type="button" className={dirty ? styles.saveBtn : styles.saveBtnDone} disabled={!dirty} onClick={save}>
            {dirty ? '保存布局' : '已保存'}
          </button>
        )}
      </div>
      <svg
        ref={svgRef}
        className={`${styles.svg} ${editMode ? styles.svgEdit : ''}`}
        viewBox={`0 0 ${VW} ${VH}`}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <rect x={4} y={4} width={VW - 8} height={VH - 8} rx={8} fill="#fafbfc" stroke="#cbd5e1" strokeWidth={6} />
        {Array.from({ length: 9 }, (_, i) => (
          <line key={`v${i}`} x1={(VW / 10) * (i + 1)} y1={4} x2={(VW / 10) * (i + 1)} y2={VH - 4} stroke="#f1f5f9" strokeWidth={1} />
        ))}
        {Array.from({ length: 3 }, (_, i) => (
          <line key={`h${i}`} x1={4} y1={(VH / 4) * (i + 1)} x2={VW - 4} y2={(VH / 4) * (i + 1)} stroke="#f1f5f9" strokeWidth={1} />
        ))}

        {devices.map((d) => {
          const p = d.position;
          if (!p) return null;
          const op = d.online ? 1 : 0.5;
          const elev = p.elev ?? 0;

          if (p.kind === 'segment') {
            return (
              <g key={d.vDeviceId} opacity={op} className={editMode ? styles.draggable : undefined}
                 onPointerDown={(e) => onPointerDown(e, d, 'body')}>
                <line x1={sx(p.x1)} y1={sy(p.y1)} x2={sx(p.x2)} y2={sy(p.y2)}
                  stroke={d.online ? '#8b5cf6' : '#c4b5fd'} strokeWidth={26} strokeLinecap="round" />
                <line x1={sx(p.x1)} y1={sy(p.y1)} x2={sx(p.x2)} y2={sy(p.y2)}
                  stroke={d.online ? '#c4b5fd' : '#ddd6fe'} strokeWidth={14} strokeLinecap="round" />
                <text x={sx((p.x1 + p.x2) / 2)} y={sy((p.y1 + p.y2) / 2) + 5}
                  textAnchor="middle" fontSize={22} fill="#5b21b6">{d.name}({elevLabel(elev)})</text>
                {editMode && (
                  <>
                    <circle cx={sx(p.x1)} cy={sy(p.y1)} r={15} fill="#7c3aed" stroke="#fff" strokeWidth={3}
                      className={styles.handle} onPointerDown={(e) => onPointerDown(e, d, 'p1')} />
                    <circle cx={sx(p.x2)} cy={sy(p.y2)} r={15} fill="#7c3aed" stroke="#fff" strokeWidth={3}
                      className={styles.handle} onPointerDown={(e) => onPointerDown(e, d, 'p2')} />
                  </>
                )}
              </g>
            );
          }

          if (p.kind === 'circle') {
            return (
              <g key={d.vDeviceId} opacity={op} className={editMode ? styles.draggable : undefined}
                 onPointerDown={(e) => onPointerDown(e, d, 'body')}>
                <circle cx={sx(p.x)} cy={sy(p.y)} r={sr(p.r)} fill={d.online ? '#fbbf24' : '#fde68a'}
                  stroke="#f59e0b" strokeWidth={3} opacity={0.85} />
                <circle cx={sx(p.x)} cy={sy(p.y)} r={sr(p.r * 0.45)} fill="#fff" opacity={0.6} />
                <text x={sx(p.x)} y={sy(p.y) + sr(p.r) + 24} textAnchor="middle" fontSize={22} fill="#92400e">{d.name}({elevLabel(elev)})</text>
                {editMode && (
                  <circle cx={sx(p.x + p.r)} cy={sy(p.y)} r={14} fill="#f59e0b" stroke="#fff" strokeWidth={3}
                    className={styles.handle} onPointerDown={(e) => onPointerDown(e, d, 'resize')} />
                )}
              </g>
            );
          }

          return (
            <g key={d.vDeviceId} opacity={op} className={editMode ? styles.draggable : undefined}
               onPointerDown={(e) => onPointerDown(e, d, 'body')}>
              <rect x={sx(p.x) - 22} y={sy(p.y) - 22} width={44} height={44} rx={10}
                fill={d.online ? '#64748b' : '#cbd5e1'} stroke="#fff" strokeWidth={3} />
              <text x={sx(p.x)} y={sy(p.y) + 8} textAnchor="middle" fontSize={26} fill="#fff">⚡</text>
              <text x={sx(p.x)} y={sy(p.y) + 44} textAnchor="middle" fontSize={20} fill="#475569">{d.name}</text>
            </g>
          );
        })}
      </svg>

      {editMode && (
        <>
          <div className={styles.mapHint}>
            🟡 吸顶灯=圆盘（拖动移动，拖右侧手柄调大小） · 🟣 灯带=长条（拖端点调方向长度） · ⬜ 网关=方块 · 所有设备可调离地高度
          </div>
          <div className={styles.elevPanel}>
            <div className={styles.elevRow}>
              <span className={styles.elevName}>房间高度</span>
              <input type="range" min={25} max={60} value={shape.h}
                onChange={(e) => { setShape((s) => ({ ...s, h: Number(e.target.value) })); setDirty(true); }} />
              <b>{(shape.h * 0.05).toFixed(1)}m</b>
            </div>
            {devices.filter((d) => d.position?.kind !== 'point').map((d) => (
              <div key={d.vDeviceId} className={styles.elevRow}>
                <span className={styles.elevName}>{d.name}</span>
                <input type="range" min={0} max={100} value={d.position?.elev ?? 0}
                  onChange={(e) => setElev(d.vDeviceId, Number(e.target.value))} />
                <b>{elevLabel(d.position?.elev ?? 0)}</b>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** 3D 预览：CSS 3D 房间盒子，设备按几何数据立体渲染（elev 决定离地高度） */
function Room3D({ room }: { room: Room }) {
  const { shape } = room;
  const W = 400;
  const D = (shape.depth / shape.w) * W;
  const H = (shape.h / shape.w) * W;

  const px = (x: number) => (x / 100) * W - W / 2;
  const pz = (y: number) => (y / 100) * D - D / 2;
  const pe = (e: number) => H / 2 - (e / 100) * H;

  return (
    <div className={styles.sceneWrap}>
      <div className={styles.scene} style={{ width: W, height: H + 200, perspective: Math.max(W, H) * 2.2 }}>
        <div className={styles.roomBox} style={{ transformStyle: 'preserve-3d', transform: 'rotateX(55deg) rotateY(-18deg)' }}>
          <div className={`${styles.face} ${styles.floor}`}
            style={{ width: W, height: D, transform: 'translate(-50%,-50%) rotateX(90deg)' }} />
          <div className={`${styles.face} ${styles.ceiling}`}
            style={{ width: W, height: D, transform: `translate(-50%,-50%) rotateX(90deg) translateZ(${H / 2}px)` }} />
          <div className={`${styles.face} ${styles.wall}`}
            style={{ width: W, height: H, transform: `translate(-50%,-50%) translateZ(${-D / 2}px)` }} />
          <div className={`${styles.face} ${styles.wall}`}
            style={{ width: D, height: H, transform: `translate(-50%,-50%) rotateY(90deg) translateZ(${-W / 2}px)` }} />
          <div className={`${styles.face} ${styles.wall}`}
            style={{ width: D, height: H, transform: `translate(-50%,-50%) rotateY(-90deg) translateZ(${-W / 2}px)` }} />

          {room.devices.map((d, i) => {
            const p = upgradePos(d, d.position) ?? defaultPos(d, i, room.devices);
            const elev = p.elev ?? 0;

            if (p.kind === 'circle') {
              const size = (p.r / 100) * W * 2;
              return (
                <div key={d.vDeviceId} className={styles.light3D}
                  style={{
                    width: size, height: size, borderRadius: '50%',
                    transform: `translate(-50%,-50%) translate3d(${px(p.x)}px, ${pe(elev)}px, ${pz(p.y)}px) rotateX(90deg)`,
                    background: d.online
                      ? 'radial-gradient(circle, #fff 0%, #fde68a 45%, #fbbf24 75%, rgba(251,191,36,0.25) 100%)'
                      : '#e5e7eb',
                    boxShadow: d.online ? `0 0 ${size / 2}px ${size / 6}px rgba(251,191,36,0.45)` : 'none',
                  }}>
                  <span className={styles.label3D}>{d.name}</span>
                </div>
              );
            }

            if (p.kind === 'segment') {
              const dx = px(p.x2) - px(p.x1);
              const dz = pz(p.y2) - pz(p.y1);
              const len = Math.sqrt(dx * dx + dz * dz);
              const angle = Math.atan2(dz, dx) * (180 / Math.PI);
              const midX = (px(p.x1) + px(p.x2)) / 2;
              const midZ = (pz(p.y1) + pz(p.y2)) / 2;
              return (
                <div key={d.vDeviceId} className={styles.strip3D}
                  style={{
                    width: len, height: 14, borderRadius: 7,
                    transform: `translate(-50%,-50%) translate3d(${midX}px, ${pe(elev)}px, ${midZ}px) rotateX(90deg) rotateZ(${-angle}deg)`,
                    background: d.online
                      ? 'linear-gradient(90deg, #c4b5fd, #8b5cf6, #c4b5fd)'
                      : '#d8d8e8',
                    boxShadow: d.online ? '0 0 22px 6px rgba(139,92,246,0.5)' : 'none',
                  }}>
                  <span className={styles.label3D}>{d.name}</span>
                </div>
              );
            }

            return (
              <div key={d.vDeviceId} className={styles.socket3D}
                style={{
                  width: 26, height: 26,
                  transform: `translate(-50%,-50%) translate3d(${px(p.x)}px, ${pe(elev) - 13}px, ${pz(p.y)}px)`,
                  background: d.online ? '#64748b' : '#cbd5e1',
                }}>
                <span className={styles.label3D}>⚡{d.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function IndexPage() {
  const [homes, setHomes] = useState<Home[]>([]);
  const [activeHome, setActiveHome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<'flat' | '3d'>('flat');
  const [editMode, setEditMode] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const data = await api('/tree');
      setHomes(data);
      if (!activeHome && data.length) {
        const first = data.find((h) => (h.deviceCount ?? 0) > 0) ?? data[0];
        setActiveHome(first.projectCode);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [activeHome]);

  useEffect(() => { load(); }, []);

  const home = homes.find((h) => h.projectCode === activeHome);

  const onSaved = (gpno: number, positions: Record<string, Pos>) => {
    setHomes((hs) => hs.map((h) => {
      if (h.projectCode !== activeHome) return h;
      return {
        ...h,
        rooms: h.rooms.map((r) => {
          if (r.gpno !== gpno) return r;
          return { ...r, devices: r.devices.map((d) => (positions[d.vDeviceId] ? { ...d, position: positions[d.vDeviceId] } : d)) };
        }),
      };
    }));
  };

  const onShapeSaved = (gpno: number, shape: RoomShape) => {
    setHomes((hs) => hs.map((h) => {
      if (h.projectCode !== activeHome) return h;
      return { ...h, rooms: h.rooms.map((r) => (r.gpno === gpno ? { ...r, shape } : r)) };
    }));
  };

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1>欧享家 · 本地控制台</h1>
        <nav className={styles.tabs}>
          {homes.map((h) => (
            <button
              key={h.projectCode}
              type="button"
              className={`${styles.tab} ${h.projectCode === activeHome ? styles.tabActive : ''}`}
              onClick={() => setActiveHome(h.projectCode)}
            >
              🏠 {h.name}
              <span className={styles.tabCount}>
                {h.onlineCount != null ? `${h.onlineCount}/${h.deviceCount}` : h.deviceCount}
              </span>
            </button>
          ))}
          <button type="button" className={styles.viewToggle}
            onClick={() => { setViewMode((v) => (v === 'flat' ? '3d' : 'flat')); if (viewMode === '3d') setEditMode(false); }}>
            {viewMode === 'flat' ? '👁 3D 预览' : '✎ 平面编辑'}
          </button>
          {viewMode === 'flat' && (
            <button type="button" className={styles.editToggle} onClick={() => setEditMode((v) => !v)}>
              {editMode ? '✓ 完成' : '✎ 编辑位置'}
            </button>
          )}
          <button type="button" className={styles.refresh} onClick={load} disabled={loading}>
            {loading ? '加载中…' : '⟳ 刷新'}
          </button>
        </nav>
      </header>

      {error && <div className={styles.error}>{error}（token 可能失效，请重新抓包更新）</div>}
      {viewMode === 'flat' && editMode && (
        <div className={styles.tip}>
          平面编辑：吸顶灯=圆盘（可调大小/离地高度），灯带=长条（可调沿墙方向/长度/安装高度），房间高度可调。
          切到「3D 预览」查看立体效果；几何数据经 GET /api/positions 输出，供 AI 理解空间关系。
        </div>
      )}
      {viewMode === '3d' && (
        <div className={styles.tip3d}>
          3D 视角（透视俯视）：黄色圆盘=吸顶灯（按 elev 离地高度悬吊），紫色长条=灯带，灰块=网关；在线设备带光照效果。
        </div>
      )}

      <main className={styles.rooms}>
        {home?.rooms.map((room) => (
          viewMode === 'flat' ? (
            <RoomMap key={`${activeHome}-${room.gpno}`} room={room} projectCode={home.projectCode} editMode={editMode} onSaved={onSaved} onShapeSaved={onShapeSaved} />
          ) : (
            <div key={`${activeHome}-${room.gpno}`} className={styles.room}>
              <div className={styles.roomHeader}>
                <h2>🛏 {room.name} <span className={styles.roomCount}>
                  {room.devices.length} 台 · {(room.shape.w * 0.05).toFixed(1)}m × {(room.shape.depth * 0.05).toFixed(1)}m × {(room.shape.h * 0.05).toFixed(1)}m
                </span></h2>
              </div>
              <Room3D room={room} />
            </div>
          )
        ))}
        {home && !home.rooms.length && <p className={styles.empty}>该家庭暂无房间</p>}
      </main>
    </div>
  );
}
