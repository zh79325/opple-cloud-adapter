export const pageConfig = () => ({
  title: '欧享家 · 本地控制台',
});
import { useEffect, useState, useCallback, useRef } from 'react';
import styles from './index.module.css';

interface Position {
  x: number; // 0-100 房间平面图横向百分比
  y: number; // 0-100 纵向百分比
  name?: string; // 位置备注（如"沙发后"/"电视墙"）
}

interface Device {
  vDeviceId: string;
  name: string;
  type: string | null;
  protocol: string | null;
  online: boolean;
  parent: string | null;
  position: Position | null;
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

// 设备图标（按类型关键词）
function deviceIcon(d: Device): string {
  const s = `${d.name}${d.type ?? ''}`;
  if (/灯带|带/.test(s)) return '📏';
  if (/吸顶灯|客厅灯|主灯/.test(s)) return '💡';
  if (/网关|插座/.test(s)) return '🔌';
  if (/传感器/.test(s)) return '📡';
  return '▫️';
}

// 未维护位置时的默认排布（按序网格铺开）
function defaultPos(i: number, total: number): Position {
  if (total <= 1) return { x: 50, y: 50 };
  const cols = Math.min(total, 4);
  const rows = Math.ceil(total / cols);
  const col = i % cols;
  const row = Math.floor(i / cols);
  return {
    x: (cols === 1 ? 50 : (col * 100) / (cols - 1)) * 0.8 + 10,
    y: (rows === 1 ? 50 : (row * 100) / (rows - 1)) * 0.7 + 15,
  };
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

/** 房间平面图：可视化 + 拖拽维护设备位置 */
function RoomMap({ room, projectCode, editMode, onSaved }: {
  room: Room;
  projectCode: string;
  editMode: boolean;
  onSaved: (gpno: number, positions: Record<string, Position>) => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [dirty, setDirty] = useState(false);
  const dragging = useRef<{ id: string; box: HTMLElement } | null>(null);

  useEffect(() => {
    setDevices(room.devices.map((d, i) => ({
      ...d,
      position: d.position ?? defaultPos(i, room.devices.length),
    })));
    setDirty(false);
  }, [room]);

  const startDrag = (e: React.PointerEvent, d: Device, box: HTMLElement) => {
    if (!editMode) return;
    e.preventDefault();
    dragging.current = { id: d.vDeviceId, box };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onDrag = (e: React.PointerEvent) => {
    const ctx = dragging.current;
    if (!ctx || !editMode) return;
    const rect = ctx.box.getBoundingClientRect();
    const x = Math.round(Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100)));
    const y = Math.round(Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100)));
    setDevices((ds) => ds.map((d) => (d.vDeviceId === ctx.id ? { ...d, position: { ...d.position, x, y } } : d)));
    setDirty(true);
  };

  const endDrag = () => { dragging.current = null; };

  const save = async () => {
    const positions: Record<string, Position> = {};
    for (const d of devices) {
      if (d.position) positions[d.vDeviceId] = { x: d.position.x, y: d.position.y, name: d.position.name };
    }
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
      <div
        className={`${styles.map} ${editMode ? styles.mapEdit : ''}`}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        {devices.map((d) => {
          const p = d.position ?? { x: 50, y: 50 };
          return (
            <div
              key={d.vDeviceId}
              className={`${styles.pin} ${d.online ? '' : styles.pinOffline} ${editMode ? styles.pinDrag : ''}`}
              style={{ left: `${p.x}%`, top: `${p.y}%` }}
              onPointerDown={(e) => startDrag(e, d, e.currentTarget.parentElement as HTMLElement)}
              title={`${d.name} (${d.vDeviceId})`}
            >
              <span className={styles.pinIcon}>{deviceIcon(d)}</span>
              <span className={styles.pinLabel}>{d.name}</span>
            </div>
          );
        })}
        {editMode && <div className={styles.mapHint}>拖动图钉调整设备位置，对应房间平面相对坐标</div>}
      </div>
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

  const onSaved = (gpno: number, positions: Record<string, Position>) => {
    // 本地同步，避免整树重拉
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
          位置编辑模式：拖动房间图中的设备图钉到实际位置后点「保存布局」。
          位置数据通过 GET /api/positions 输出，供 AI 理解设备空间关系做组合控制。
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
