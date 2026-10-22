export const pageConfig = () => ({
  title: '欧享家 · 本地控制台',
});
import { useEffect, useState, useCallback, useRef } from 'react';
import styles from './index.module.css';

/**
 * 几何模型 V2（房间平面 0-100 百分比坐标，房间矩形）：
 * - 吸顶灯（圆盘，面光源）：{ kind: 'circle', x, y, r } —— r 为半径（房间宽的百分比）
 * - 灯带（长条线段）：{ kind: 'segment', x1, y1, x2, y2 } —— 沿墙方向与长度
 * - 网关/插座等（点）：{ kind: 'point', x, y }
 */
interface CirclePos { kind: 'circle'; x: number; y: number; r: number; name?: string }
interface SegmentPos { kind: 'segment'; x1: number; y1: number; x2: number; y2: number; name?: string }
interface PointPos { kind: 'point'; x: number; y: number; name?: string }
type Pos = CirclePos | SegmentPos | PointPos;

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

// 设备几何分类
function isStrip(d: Device): boolean {
  return /灯带|带|精灵/.test(`${d.name}${d.type ?? ''}`);
}
function isCeiling(d: Device): boolean {
  return /吸顶灯|客厅灯|主灯/.test(`${d.name}${d.type ?? ''}`);
}

// 默认布局：灯带贴四面墙（按序），吸顶灯居中，网关网格
const WALLS = [
  { x1: 10, y1: 15, x2: 10, y2: 85 },   // 左墙
  { x1: 90, y1: 15, x2: 90, y2: 85 },   // 右墙
  { x1: 15, y1: 10, x2: 85, y2: 10 },   // 上墙
  { x1: 15, y1: 90, x2: 85, y2: 90 },   // 下墙
];

function defaultPos(d: Device, i: number, devices: Device[]): Pos {
  if (isStrip(d)) {
    const stripsBefore = devices.slice(0, i).filter(isStrip).length;
    return { kind: 'segment', ...WALLS[stripsBefore % WALLS.length] };
  }
  if (isCeiling(d)) {
    // 多盏吸顶灯纵向排布
    const ceilings = devices.map((x, idx) => (isCeiling(x) ? idx : -1)).filter((v) => v >= 0);
    const ci = ceilings.indexOf(i);
    const total = ceilings.length;
    const y = total === 1 ? 50 : 25 + (ci * 50) / (total - 1);
    return { kind: 'circle', x: 50, y, r: 8 };
  }
  // 网关/插座等点设备
  const points = devices.map((x, idx) => (!isStrip(x) && !isCeiling(x) ? idx : -1)).filter((v) => v >= 0);
  const pi = points.indexOf(i);
  const total = points.length;
  if (total <= 0) return { kind: 'point', x: 50, y: 50 };
  const cols = Math.min(total, 3);
  const col = pi % cols;
  const row = Math.floor(pi / cols);
  return {
    kind: 'point',
    x: cols === 1 ? 50 : (col * 100) / (cols - 1) * 0.5 + 25,
    y: row === 0 ? 85 : 95,
  };
}

// 旧数据兼容升级：{x,y} → 按设备类型转为 circle/segment/point
function upgradePos(d: Device, raw: any): Pos | null {
  if (!raw) return null;
  if (raw.kind === 'circle' || raw.kind === 'segment' || raw.kind === 'point') {
    // 补默认值（如旧 circle 无 r）
    if (raw.kind === 'circle' && !raw.r) return { ...raw, r: 8 };
    return raw;
  }
  if (raw.x !== undefined && raw.y !== undefined) {
    if (isCeiling(d)) return { kind: 'circle', x: raw.x, y: raw.y, r: 8 };
    if (isStrip(d)) return { kind: 'segment', x1: raw.x, y1: clamp(raw.y - 30), x2: raw.x, y2: clamp(raw.y + 30) };
    return { kind: 'point', x: raw.x, y: raw.y };
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

// SVG 视图：平面百分比 → SVG 坐标（VW:VH = 1000:400 ≈ 2.5:1 房间比例）
const VW = 1000, VH = 400;
const sx = (x: number) => (x / 100) * VW;
const sy = (y: number) => (y / 100) * VH;
// 半径按横向比例换算（r 是房间宽的百分比）
const sr = (r: number) => (r / 100) * VW;

/** 房间平面图（SVG）：吸顶灯=圆盘（可拖动/调半径），灯带=长条（可拖动/拉端点） */
function RoomMap({ room, projectCode, editMode, onSaved }: {
  room: Room;
  projectCode: string;
  editMode: boolean;
  onSaved: (gpno: number, positions: Record<string, Pos>) => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [dirty, setDirty] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // 拖拽：拖整体 / 灯带端点 p1/p2 / 圆盘半径 resize
  const drag = useRef<{ id: string; part: 'body' | 'p1' | 'p2' | 'resize'; grabPx: { x: number; y: number }; grabPos: Pos } | null>(null);

  useEffect(() => {
    setDevices(room.devices.map((d, i) => ({
      ...d,
      position: upgradePos(d, d.position) ?? defaultPos(d, i, room.devices),
    })));
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
          // 半径 = 指针到圆心距离（横向比例）
          const dist = Math.abs(p.x - g.x) / 1 || 0;
          return { ...d, position: { ...g, r: Math.max(3, Math.round(dist)) } };
        }
        return { ...d, position: { ...g, x: clamp(g.x + dx), y: clamp(g.y + dy) } };
      }
      // segment
      if (ctx.part === 'p1') return { ...d, position: { ...g, x1: p.x, y1: p.y } };
      if (ctx.part === 'p2') return { ...d, position: { ...g, x2: p.x, y2: p.y } };
      const lenDx = g.x2 - g.x1, lenDy = g.y2 - g.y1;
      const nx1 = clamp(g.x1 + dx), ny1 = clamp(g.y1 + dy);
      return { ...d, position: { ...g, x1: nx1, y1: ny1, x2: clamp(nx1 + lenDx), y2: clamp(ny1 + lenDy) } };
    }));
    setDirty(true);
  };

  const onPointerUp = () => { drag.current = null; };

  const save = async () => {
    const positions: Record<string, Pos> = {};
    for (const d of devices) if (d.position) positions[d.vDeviceId] = d.position;
    try {
      await api('/positions', {
        method: 'POST',
        body: JSON.stringify({ projectCode, gpno: room.gpno, positions }),
      });
      setDirty(false);
      onSaved(room.gpno, positions);
    } catch (e: any) {
      alert(`保存失败: ${e.message}`);
    }
  };

  return (
    <div className={styles.room}>
      <div className={styles.roomHeader}>
        <h2>🛏 {room.name} <span className={styles.roomCount}>{devices.length} 台</span></h2>
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
        {/* 房间墙体矩形 */}
        <rect x={4} y={4} width={VW - 8} height={VH - 8} rx={8} fill="#fafbfc" stroke="#cbd5e1" strokeWidth={6} />
        {/* 网格参考线 */}
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

          if (p.kind === 'segment') {
            return (
              <g key={d.vDeviceId} opacity={op} className={editMode ? styles.draggable : undefined}
                 onPointerDown={(e) => onPointerDown(e, d, 'body')}>
                <line x1={sx(p.x1)} y1={sy(p.y1)} x2={sx(p.x2)} y2={sy(p.y2)}
                  stroke={d.online ? '#8b5cf6' : '#c4b5fd'} strokeWidth={26} strokeLinecap="round" />
                <line x1={sx(p.x1)} y1={sy(p.y1)} x2={sx(p.x2)} y2={sy(p.y2)}
                  stroke={d.online ? '#c4b5fd' : '#ddd6fe'} strokeWidth={14} strokeLinecap="round" />
                <text x={sx((p.x1 + p.x2) / 2)} y={sy((p.y1 + p.y2) / 2) + 5}
                  textAnchor="middle" fontSize={22} fill="#5b21b6">{d.name}</text>
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
            // 吸顶灯：圆盘 + 中心光晕 + 半径手柄
            return (
              <g key={d.vDeviceId} opacity={op} className={editMode ? styles.draggable : undefined}
                 onPointerDown={(e) => onPointerDown(e, d, 'body')}>
                <circle cx={sx(p.x)} cy={sy(p.y)} r={sr(p.r)} fill={d.online ? '#fbbf24' : '#fde68a'}
                  stroke="#f59e0b" strokeWidth={3} opacity={0.85} />
                <circle cx={sx(p.x)} cy={sy(p.y)} r={sr(p.r * 0.45)} fill="#fff" opacity={0.6} />
                <text x={sx(p.x)} y={sy(p.y) + sr(p.r) + 24} textAnchor="middle" fontSize={22} fill="#92400e">{d.name}</text>
                {editMode && (
                  <circle cx={sx(p.x + p.r)} cy={sy(p.y)} r={14} fill="#f59e0b" stroke="#fff" strokeWidth={3}
                    className={styles.handle} onPointerDown={(e) => onPointerDown(e, d, 'resize')} />
                )}
              </g>
            );
          }

          // 网关/插座等：小圆点
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
        <div className={styles.mapHint}>
          🟡 吸顶灯=圆盘（拖动移动，拖右侧手柄调大小） · 🟣 灯带=长条（拖动移动，拖两端端点调方向与长度） · ⬜ 网关=方块
        </div>
      )}
    </div>
  );
}

export default function IndexPage() {
  const [homes, setHomes] = useState<Home[]>([]);
  const [activeHome, setActiveHome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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
          <button type="button" className={styles.editToggle} onClick={() => setEditMode((v) => !v)}>
            {editMode ? '✓ 完成' : '✎ 编辑位置'}
          </button>
          <button type="button" className={styles.refresh} onClick={load} disabled={loading}>
            {loading ? '加载中…' : '⟳ 刷新'}
          </button>
        </nav>
      </header>

      {error && <div className={styles.error}>{error}（token 可能失效，请重新抓包更新）</div>}
      {editMode && (
        <div className={styles.tip}>
          位置编辑模式：按设备真实形态编辑——吸顶灯是圆盘（可调大小），灯带是长条（可调沿墙方向与长度）。
          几何数据（kind/circle 半径/segment 端点）通过 GET /api/positions 输出，供 AI 理解空间关系做组合控制。
        </div>
      )}

      <main className={styles.rooms}>
        {home?.rooms.map((room) => (
          <RoomMap key={`${activeHome}-${room.gpno}`} room={room} projectCode={home.projectCode} editMode={editMode} onSaved={onSaved} />
        ))}
        {home && !home.rooms.length && <p className={styles.empty}>该家庭暂无房间</p>}
      </main>
    </div>
  );
}
