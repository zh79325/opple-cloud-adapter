import { useEffect, useState, useCallback, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import styles from './index.module.css';

export const pageConfig = () => ({
  title: '欧享家 · 家庭设备管理台',
});

/**
 * 几何模型 V4（3D 完整空间语义，全部为房间尺寸百分比 0-100）：
 * 房间：{ w, h, depth } —— 宽/高/深（h 为高度，决定房间盒子比例）
 * - 吸顶灯（圆盘面光源）：{ kind: 'circle', x, y, r, elev } —— x/y 平面位置、r 半径、elev 悬吊高度（0=地，100=天花）
 * - 灯带（可弯折软带）：{ kind: 'segment', points: [{x,y},...], elev } —— 平面路径（折线，≥2 顶点）+ elev 安装高度（踢脚线≈10，顶棚≈95）
 * - 网关/插座：{ kind: 'point', x, y, elev } —— elev≈0 地面，≈30 墙面
 */
interface PathPoint { x: number; y: number }
/** 布局编辑器吸附提示：gx/gy 为对齐参考线坐标（null=无），vertex 为端点对接命中的目标顶点 */
interface SnapHint { gx: number | null; gy: number | null; vertex: PathPoint | null }
interface CirclePos { kind: 'circle'; x: number; y: number; r: number; elev?: number; name?: string }
interface SegmentPos { kind: 'segment'; points: PathPoint[]; elev?: number; name?: string }
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
  excluded: boolean; // 手动排除出空间模型（不参与位置编辑与 3D 渲染）
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
const UNIT = 0.05; // 每百分比单位对应米数（100 单位 = 5m）
const SNAP = 1.2; // 编辑器吸附阈值（0-100 坐标，1 单位 ≈ 画布宽 1%）

const clamp = (v: number, min = 0, max = 100) => Math.round(Math.min(max, Math.max(min, v)));
const toM = (v: number) => (v * UNIT).toFixed(1);

/** ISO 时间 → 本地 "MM-DD HH:mm" */
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function isStrip(d: Device): boolean {
  return /灯带|带|精灵/.test(`${d.name}${d.type ?? ''}`);
}
function isCeiling(d: Device): boolean {
  return /吸顶灯|客厅灯|主灯/.test(`${d.name}${d.type ?? ''}`);
}
function kindOf(d: Device): 'circle' | 'segment' | 'point' {
  if (isCeiling(d)) return 'circle';
  if (isStrip(d)) return 'segment';
  return 'point';
}
const KIND_LABEL: Record<'circle' | 'segment' | 'point', string> = {
  circle: '吸顶灯',
  segment: '灯带',
  point: '网关/点位',
};
/** 仅灯具（灯/灯带）可参与空间模型；网关等点位永远不占位 */
const isPositioned = (d: Device) => kindOf(d) !== 'point';
/** 实际参与空间渲染与位置编辑的设备：灯具且未被手动排除 */
const inSpace = (d: Device) => isPositioned(d) && !d.excluded;

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    // 非 JSON 响应：最常见是 dev 代理目标（5170 后端）未启动时 http-proxy 返回的纯文本错误页
    if (text.includes('Error occurred while trying to proxy')) {
      throw new Error('本地后端未启动（端口 5170）：请在仓库根目录先运行 npm run web，再刷新页面');
    }
    throw new Error(`后端返回非 JSON（HTTP ${res.status}）：${text.slice(0, 80)}`);
  }
  if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

// 默认布局：灯带贴四面墙 elev=10（两点起步，可在编辑器中弯折），吸顶灯居中 elev=95，网关 elev=0
const WALLS: PathPoint[][] = [
  [{ x: 10, y: 15 }, { x: 10, y: 85 }],
  [{ x: 90, y: 15 }, { x: 90, y: 85 }],
  [{ x: 15, y: 10 }, { x: 85, y: 10 }],
  [{ x: 15, y: 90 }, { x: 85, y: 90 }],
];

/** 旧格式（x1,y1,x2,y2 两点直线）→ 新格式 points 折线；其余原样返回 */
function normalizePos(p: Pos | null): Pos | null {
  if (p && p.kind === 'segment' && !Array.isArray((p as SegmentPos).points)) {
    const old = p as unknown as { x1: number; y1: number; x2: number; y2: number; elev?: number };
    return {
      kind: 'segment',
      points: [{ x: old.x1, y: old.y1 }, { x: old.x2, y: old.y2 }],
      elev: old.elev,
    };
  }
  return p;
}

function defaultPos(d: Device, i: number, devices: Device[]): Pos {
  if (isStrip(d)) {
    const stripsBefore = devices.slice(0, i).filter(isStrip).length;
    return { kind: 'segment', points: WALLS[stripsBefore % WALLS.length].map((pt) => ({ ...pt })), elev: 10 };
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

// ---- 小图标（currentColor，随容器着色） ----
function GlyphCircle() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="12" cy="12" r="3" fill="currentColor" />
    </svg>
  );
}
function GlyphStrip() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <line x1="4" y1="17" x2="20" y2="7" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}
function GlyphPoint() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="3" fill="currentColor" />
    </svg>
  );
}
function GlyphHouse() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path d="M4 11.2 12 4.5l8 6.7V19a1 1 0 0 1-1 1h-4.6v-5h-4.8v5H5a1 1 0 0 1-1-1z" fill="currentColor" />
    </svg>
  );
}
function GlyphPencil() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z" fill="currentColor" />
    </svg>
  );
}
function GlyphRefresh() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <path d="M12 5a7 7 0 1 0 6.3 4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M12 1.8 15.6 5 12 8.2z" fill="currentColor" />
    </svg>
  );
}
function GlyphSync() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <path d="M12 3.5v9.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="m8 9.5 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.5 15.5V18a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
function GlyphArrowLeft() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
      <path d="M14.5 5 7.5 12l7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function GlyphEye() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.8" fill="currentColor" />
    </svg>
  );
}
function GlyphEyeOff() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.8 3.7M6.3 6.9A16 16 0 0 0 2.5 12S6 19 12 19a9 9 0 0 0 4-0.9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

// ---- 房间卡片迷你平面图（静态，无交互；仅参与空间模型的灯/灯带） ----
function MiniPlan({ room }: { room: Room }) {
  const { w, depth } = room.shape;
  const vh = Math.max(40, Math.round((depth / w) * 100));
  const positioned = room.devices.filter(inSpace);
  return (
    <svg className={styles.miniPlan} viewBox={`0 0 100 ${vh}`} preserveAspectRatio="xMidYMid meet">
      <rect x={1.5} y={1.5} width={97} height={vh - 3} rx={4} className={styles.miniFloor} />
      {positioned.map((d, i) => {
        const p = d.position ?? defaultPos(d, i, positioned);
        if (p.kind === 'segment') {
          return (
            <polyline key={d.vDeviceId}
              points={p.points.map((pt) => `${pt.x},${(pt.y / 100) * vh}`).join(' ')}
              fill="none" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"
              className={d.online ? styles.miniSegOn : styles.miniSegOff} />
          );
        }
        if (p.kind === 'circle') {
          return (
            <circle key={d.vDeviceId} cx={p.x} cy={(p.y / 100) * vh} r={Math.max(3, p.r * 0.8)}
              className={d.online ? styles.miniLampOn : styles.miniLampOff} />
          );
        }
        return (
          <rect key={d.vDeviceId} x={p.x - 2.2} y={(p.y / 100) * vh - 2.2} width={4.4} height={4.4} rx={1.2}
            className={d.online ? styles.miniPointOn : styles.miniPointOff} />
        );
      })}
    </svg>
  );
}

// ---- 房间卡片 ----
function RoomCard({ room, onOpen }: { room: Room; onOpen: () => void }) {
  const online = room.devices.filter((d) => d.online).length;
  return (
    <button type="button" className={styles.roomCard} onClick={onOpen}>
      <div className={styles.roomCardPlan}>
        <MiniPlan room={room} />
        <span className={`${styles.badge} ${online > 0 ? styles.badgeLive : styles.badgeIdle}`}>
          {online}/{room.devices.length} 在线
        </span>
      </div>
      <div className={styles.roomCardBody}>
        <span className={styles.roomCardName}>{room.name}</span>
        <span className={styles.roomCardMeta}>
          {toM(room.shape.w)}m × {toM(room.shape.depth)}m · {room.devices.length} 台设备
        </span>
      </div>
      <span className={styles.roomCardGo}>进入 3D 预览 →</span>
    </button>
  );
}

// ---- 家庭页：统计 + 房间列表 ----
function HomeView({ home, onOpenRoom }: { home: Home | undefined; onOpenRoom: (gpno: number) => void }) {
  if (!home) return <div className={styles.empty}>未找到家庭数据</div>;
  const devices = home.rooms.flatMap((r) => r.devices);
  const online = devices.filter((d) => d.online).length;
  return (
    <main className={styles.main}>
      <section className={styles.statsRow}>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{home.rooms.length}</span>
          <span className={styles.statLabel}>房间</span>
        </div>
        <div className={styles.statCard}>
          <span className={styles.statValue}>{devices.length || home.deviceCount}</span>
          <span className={styles.statLabel}>设备</span>
        </div>
        <div className={styles.statCard}>
          <span className={`${styles.statValue} ${styles.statValueOnline}`}>{online}</span>
          <span className={styles.statLabel}>在线</span>
        </div>
      </section>

      <section>
        <div className={styles.sectionHead}>
          <h2>房间</h2>
          <span className={styles.sectionSub}>点击房间进入 3D 预览与布局编辑</span>
        </div>
        <div className={styles.roomGrid}>
          {home.rooms.map((room) => (
            <RoomCard key={room.gpno} room={room} onOpen={() => onOpenRoom(room.gpno)} />
          ))}
        </div>
        {!home.rooms.length && <div className={styles.empty}>该家庭暂无房间</div>}
      </section>
    </main>
  );
}

// ---- 3D 预览：Three.js（WebGL）真实光照渲染，OrbitControls 自由视角 ----
function RoomScene3D({ room }: { room: Room }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const { shape } = room;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    const W0 = mount.clientWidth || 640;
    const H0 = mount.clientHeight || 480;

    // 世界单位=米；以地面为 y=0，房间中心 x/z=0
    const wm = shape.w * UNIT;
    const dm = shape.depth * UNIT;
    const hm = shape.h * UNIT;
    const wx = (x: number) => (x / 100) * wm - wm / 2;
    const wz = (y: number) => (y / 100) * dm - dm / 2;
    const wy = (e: number) => (e / 100) * hm;
    const positioned = room.devices.filter(inSpace);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, W0 / H0, 0.05, 80);
    camera.position.set(wm * 0.85, hm * 2.6, dm * 1.6);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(W0, H0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);

    // RectAreaLight（线光源）所需的 LTC uniforms，init 幂等
    RectAreaLightUniformsLib.init();
    // 底光：保证暗部轮廓可见，不干扰灯光色彩
    scene.add(new THREE.HemisphereLight(0x3a4a6f, 0x0a0e1a, 0.5));

    const stdMat = (opts: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(opts);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(wm, dm),
      stdMat({ color: 0x1c2334, roughness: 0.88, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(wm, Math.max(4, Math.round(wm / 0.5)), 0x324064, 0x26304c);
    grid.scale.z = dm / wm;
    grid.position.y = 0.004;
    scene.add(grid);
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(wm, dm),
      stdMat({ color: 0x151b2c, roughness: 0.95, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = hm;
    scene.add(ceil);
    const wallMat = stdMat({ color: 0x1d2540, roughness: 0.95, transparent: true, opacity: 0.92, side: THREE.DoubleSide });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(wm, hm), wallMat);
    back.position.set(0, hm / 2, -dm / 2);
    back.receiveShadow = true;
    const left = new THREE.Mesh(new THREE.PlaneGeometry(dm, hm), wallMat);
    left.rotation.y = Math.PI / 2;
    left.position.set(-wm / 2, hm / 2, 0);
    left.receiveShadow = true;
    const right = new THREE.Mesh(new THREE.PlaneGeometry(dm, hm), wallMat);
    right.rotation.y = -Math.PI / 2;
    right.position.set(wm / 2, hm / 2, 0);
    right.receiveShadow = true;
    scene.add(back, left, right);

    /** 设备名标签（Canvas 纹理 Sprite，中文可渲染） */
    const makeLabel = (text: string): THREE.Sprite => {
      const cv = document.createElement('canvas');
      const ctx = cv.getContext('2d')!;
      const font = '600 30px -apple-system, PingFang SC, sans-serif';
      ctx.font = font;
      cv.width = Math.ceil(ctx.measureText(text).width) + 28;
      cv.height = 48;
      const c2 = cv.getContext('2d')!;
      c2.font = font;
      c2.fillStyle = 'rgba(10, 15, 30, 0.72)';
      c2.beginPath();
      c2.roundRect(0, 0, cv.width, cv.height, 12);
      c2.fill();
      c2.fillStyle = 'rgba(231, 236, 246, 0.95)';
      c2.textBaseline = 'middle';
      c2.fillText(text, 14, cv.height / 2 + 2);
      const tex = new THREE.CanvasTexture(cv);
      tex.anisotropy = 4;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      const hM = 0.22;
      sp.scale.set((cv.width / cv.height) * hM, hM, 1);
      return sp;
    };

    // 设备：吸顶灯 = 自发光圆盘 + 暖色点光；灯带 = 自发光折线管 + 沿段紫色点光（一律按在线渲染，不区分离线）
    positioned.forEach((d, i) => {
      const p = d.position ?? defaultPos(d, i, positioned);
      if (!p || p.kind === 'point') return;
      const elev = p.elev ?? 0;
      const g = new THREE.Group();

      if (p.kind === 'circle') {
        const rm = Math.max(0.08, (p.r / 100) * wm);
        const disk = new THREE.Mesh(
          new THREE.CircleGeometry(rm, 48),
          stdMat({
            color: 0xfff3d6,
            emissive: 0xffc63f,
            emissiveIntensity: 1.8,
            roughness: 0.4,
            side: THREE.DoubleSide,
          }),
        );
        disk.rotation.x = Math.PI / 2; // 面朝下
        disk.position.set(wx(p.x), wy(elev), wz(p.y));
        g.add(disk);
        const pl = new THREE.PointLight(0xffc98a, 26, 0, 2);
        pl.position.copy(disk.position).add(new THREE.Vector3(0, -0.08, 0));
        pl.castShadow = true;
        pl.shadow.mapSize.set(1024, 1024);
        pl.shadow.bias = -0.004;
        g.add(pl);
        const lb = makeLabel(d.name);
        lb.position.set(wx(p.x), wy(elev) - 0.16, wz(p.y));
        g.add(lb);
      }

      if (p.kind === 'segment') {
        const pts = p.points.map((pt) => new THREE.Vector3(wx(pt.x), wy(elev), wz(pt.y)));
        // 贴墙灯带保持折线段的直线形态（不做样条平滑，直角弯不得鼓弧）；
        // 拐角放同材质小球衔接相邻管段，盖住圆截面交叉缺口与法线跳变，视觉仍是连续平滑光带
        const segMat = stdMat({
          color: 0xd8ccff,
          emissive: 0x8b5cf6,
          emissiveIntensity: 2.2,
          roughness: 0.5,
        });
        const ballGeo = new THREE.SphereGeometry(0.022, 12, 8);
        for (let j = 0; j < pts.length - 1; j++) {
          g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.LineCurve3(pts[j], pts[j + 1]), 8, 0.022, 10, false), segMat));
        }
        for (let j = 1; j < pts.length - 1; j++) {
          const ball = new THREE.Mesh(ballGeo, segMat);
          ball.position.copy(pts[j]);
          g.add(ball);
        }
        // 线光源：每段一个 RectAreaLight（宽=段长、高=0.04 细缝，单面发光）
        // 踢脚带（elev<50）光朝房间内侧、灯槽（elev>=50）朝下偏内洗墙；强度为经验值可调
        for (let j = 0; j < pts.length - 1; j++) {
          const a = pts[j];
          const b = pts[j + 1];
          const len = a.distanceTo(b);
          if (len < 0.05) continue;
          const mid = a.clone().add(b).multiplyScalar(0.5);
          const horiz = new THREE.Vector3(-(b.z - a.z), 0, b.x - a.x).normalize();
          if (mid.clone().add(horiz).lengthSq() > mid.lengthSq()) horiz.negate(); // 取朝房间中心一侧
          const down = new THREE.Vector3(0, -1, 0);
          const aim = elev >= 50
            ? down.clone().addScaledVector(horiz, 0.45).normalize()
            : horiz.clone().addScaledVector(down, 0.3).normalize();
          const rl = new THREE.RectAreaLight(0xa78bfa, 30, len, 0.04);
          rl.position.copy(mid);
          rl.lookAt(mid.clone().add(aim));
          g.add(rl);
        }
        let li = 0;
        for (let j = 1; j < pts.length - 1; j++) {
          if (pts[j].distanceTo(pts[j + 1]) > pts[li].distanceTo(pts[li + 1])) li = j;
        }
        const lb = makeLabel(d.name);
        lb.position.copy(pts[li]).add(pts[li + 1]).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.14, 0));
        g.add(lb);
      }

      scene.add(g);
    });

    // 自由视角：左键旋转 / 右键平移 / 滚轮缩放，带阻尼
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, hm * 0.5, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.8;
    controls.maxDistance = 25;
    controls.update();
    controls.saveState(); // 双击/按钮复位基准
    controlsRef.current = controls;
    const onDbl = (e: MouseEvent) => {
      e.preventDefault();
      controls.reset();
    };
    renderer.domElement.addEventListener('dblclick', onDbl);
    const onCtx = (e: MouseEvent) => e.preventDefault();
    renderer.domElement.addEventListener('contextmenu', onCtx);

    // 自适应容器尺寸
    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(mount);

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('dblclick', onDbl);
      renderer.domElement.removeEventListener('contextmenu', onCtx);
      controls.dispose();
      controlsRef.current = null;
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.MeshStandardMaterial | THREE.SpriteMaterial | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) {
          if (mat.map) mat.map.dispose();
          mat.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, [room]);

  return (
    <div ref={mountRef} className={styles.scene}>
      <div className={styles.sceneToolbar}>
        <span className={styles.sceneHint}>左键拖拽旋转 · 右键拖动平移 · 滚轮缩放 · 双击复位</span>
        <span>{toM(shape.w)}m × {toM(shape.depth)}m × {toM(shape.h)}m</span>
        <button
          type="button"
          className={styles.viewResetBtn}
          onClick={() => controlsRef.current?.reset()}
          title="恢复默认视角"
        >
          复位视角
        </button>
      </div>
    </div>
  );
}

// ---- 米数输入框：内部草稿态自由编辑（可删空、可敲 "0." 等中间态，不被受控值回写），
// 合法数值即时联动滑杆，失焦/回车收口（非法或空内容恢复显示受控值） ----
function NumField({ value, min, max, onCommit }: {
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null); // null = 非编辑态，显示受控值
  const handle = (raw: string) => {
    setDraft(raw);
    const t = raw.trim();
    const m = Number(t);
    if (t !== '' && Number.isFinite(m)) {
      const v = Math.min(max, Math.max(min, m));
      if (v !== value) onCommit(v);
    }
  };
  const finish = () => {
    if (draft === null) return;
    handle(draft);
    setDraft(null);
  };
  return (
    <input className={styles.numInput} type="number" step={0.1} min={min} max={max}
      value={draft ?? String(value)}
      onChange={(e) => handle(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
  );
}

// ---- 二维平面编辑器 ----
function RoomEditor({ room, projectCode, onSaved, onShapeSaved, onDone }: {
  room: Room;
  projectCode: string;
  onSaved: (gpno: number, positions: Record<string, Pos>) => void;
  onShapeSaved: (gpno: number, shape: RoomShape) => void;
  onDone: () => void;
}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [shape, setShape] = useState<RoomShape>(room.shape);
  const [dirty, setDirty] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ id: string; part: string; grabPx: { x: number; y: number }; grabPos: Pos } | null>(null);
  const [snapHint, setSnapHint] = useState<SnapHint | null>(null);

  /** 收集吸附候选点：其他设备的灯带顶点与吸顶灯圆心；
   *  单顶点拖动（selfSkipIdx 传入）时额外含自身灯带其余顶点，否则无法与自身另一端对齐出水平/垂直段；
   *  body 平移（不传）排除自身，防自身顶点互吸跳动 */
  const snapTargets = (selfId: string, selfSkipIdx?: number): PathPoint[] => devices
    .flatMap((d) => {
      const p = d.position;
      if (!p) return [];
      const self = d.vDeviceId === selfId;
      if (p.kind === 'segment') {
        if (self) return selfSkipIdx === undefined ? [] : p.points.filter((_, j) => j !== selfSkipIdx);
        return p.points;
      }
      if (p.kind === 'circle') return self ? [] : [{ x: p.x, y: p.y }];
      return [];
    });

  /** 吸附：候选点轴对齐（同点双向命中=端点对接）+ 墙边/贴墙吸边，返回修正坐标与提示 */
  const computeSnap = (nx: number, ny: number, selfId: string, edges: number[], selfSkipIdx?: number) => {
    let bx: { d: number; v: number; pt: PathPoint | null } | null = null;
    let by: { d: number; v: number; pt: PathPoint | null } | null = null;
    const better = (cur: typeof bx, d: number, v: number, pt: PathPoint | null) =>
      (!cur || Math.abs(d) < Math.abs(cur.d) ? { d, v, pt } : cur);
    for (const t of snapTargets(selfId, selfSkipIdx)) {
      const ddx = t.x - nx;
      if (Math.abs(ddx) < SNAP) bx = better(bx, ddx, t.x, t);
      const ddy = t.y - ny;
      if (Math.abs(ddy) < SNAP) by = better(by, ddy, t.y, t);
    }
    for (const ed of edges) {
      const ddx = ed - nx;
      if (Math.abs(ddx) < SNAP) bx = better(bx, ddx, ed, null);
      const ddy = ed - ny;
      if (Math.abs(ddy) < SNAP) by = better(by, ddy, ed, null);
    }
    return {
      x: nx + (bx?.d ?? 0),
      y: ny + (by?.d ?? 0),
      gx: bx ? bx.v : null,
      gy: by ? by.v : null,
      vertex: bx?.pt && by?.pt && bx.pt === by.pt ? bx.pt : null,
    };
  };

  useEffect(() => {
    // 仅参与空间模型的灯具参与布局编辑；网关等点位与手动排除的设备不占位
    const positioned = room.devices.filter(inSpace);
    setDevices(positioned.map((d, i) => ({
      ...d,
      position: d.position ?? defaultPos(d, i, positioned),
    })));
    setShape(room.shape);
    setDirty(false);
  }, [room]);

  // 画布随房间宽深比变化（坐标仍为 0-100 百分比）
  const VW = 1000;
  const VH = Math.max(420, Math.round((VW * shape.depth) / shape.w));
  const sx = (x: number) => (x / 100) * VW;
  const sy = (y: number) => (y / 100) * VH;
  const sr = (r: number) => (r / 100) * VW;

  const toPct = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: clamp(((e.clientX - rect.left) / rect.width) * 100),
      y: clamp(((e.clientY - rect.top) / rect.height) * 100),
    };
  };

  const lastPick = useRef<{ id: string; x: number; y: number } | null>(null);

  /** 点击位置命中的设备 id 列表（上→下，去重），用于重叠时循环穿透选中被压住的设备 */
  const hitDevices = (e: React.PointerEvent): string[] => {
    const ids: string[] = [];
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (el === svgRef.current) break;
      const id = el.closest?.('[data-dev-id]')?.getAttribute('data-dev-id');
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  };

  /** 将设备移到渲染末尾 = SVG 最上层（重叠时点击谁就提谁，方便调整被压住的端点） */
  const raiseDevice = (id: string) => {
    setDevices((ds) => {
      const i = ds.findIndex((x) => x.vDeviceId === id);
      if (i < 0 || i === ds.length - 1) return ds;
      const next = [...ds];
      const [it] = next.splice(i, 1);
      next.push(it);
      return next;
    });
  };

  const onPointerDown = (e: React.PointerEvent, d: Device, part: string) => {
    e.preventDefault();
    e.stopPropagation();
    let target = d;
    let actPart = part;
    // 重叠穿透：同处再次点击最上层时，循环切到被压住的下一台并置顶（Figma 式循环选择）
    const hits = hitDevices(e);
    const again = !!lastPick.current
      && lastPick.current.id === d.vDeviceId
      && Math.abs(lastPick.current.x - e.clientX) < 8
      && Math.abs(lastPick.current.y - e.clientY) < 8;
    if (hits.length > 1 && again) {
      const nextId = hits[(hits.indexOf(d.vDeviceId) + 1) % hits.length];
      const nd = devices.find((x) => x.vDeviceId === nextId);
      if (nd?.position) {
        target = nd;
        actPart = 'body';
      }
    }
    lastPick.current = { id: target.vDeviceId, x: e.clientX, y: e.clientY };
    raiseDevice(target.vDeviceId);
    drag.current = { id: target.vDeviceId, part: actPart, grabPx: toPct(e), grabPos: target.position! };
    // capture 设在稳定的 svg 根上：置顶重排会移动设备 DOM 节点，节点上的 capture 会丢拖拽
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const ctx = drag.current;
    if (!ctx) return;
    const p = toPct(e);
    const dx = p.x - ctx.grabPx.x;
    const dy = p.y - ctx.grabPx.y;
    const g = ctx.grabPos;
    if (g.kind === 'point') return; // 点位不参与编辑（列表已过滤，仅作类型守卫）

    // 半径手柄：不参与吸附
    if (g.kind === 'circle' && ctx.part === 'resize') {
      const r = Math.max(3, Math.round(Math.abs(p.x - g.x)));
      setDevices((ds) => ds.map((d) => (d.vDeviceId === ctx.id ? { ...d, position: { ...g, r } } : d)));
      setSnapHint(null);
      setDirty(true);
      return;
    }

    let hint: SnapHint = { gx: null, gy: null, vertex: null };
    let patch: (grab: Pos) => Pos;

    if (g.kind === 'circle') {
      // 圆心吸附：其他关键点轴对齐 + 圆盘贴墙（圆心到边 = 半径）
      const s = computeSnap(clamp(g.x + dx), clamp(g.y + dy), ctx.id, [g.r, 100 - g.r]);
      hint = { gx: s.gx, gy: s.gy, vertex: null };
      patch = () => ({ ...g, x: clamp(s.x), y: clamp(s.y) });
    } else if (ctx.part === 'body') {
      // 整条平移：任一顶点命中吸附即取修正量最小者，整条跟随（保持形状）
      let adjX = 0;
      let adjY = 0;
      let score = Infinity;
      for (const pt of g.points) {
        const bx = pt.x + dx;
        const by = pt.y + dy;
        const s = computeSnap(bx, by, ctx.id, [0, 100]);
        const sc = Math.abs(s.x - bx) + Math.abs(s.y - by);
        if (sc < score) {
          score = sc;
          adjX = s.x - bx;
          adjY = s.y - by;
          hint = { gx: s.gx, gy: s.gy, vertex: s.vertex };
        }
      }
      patch = () => ({ ...g, points: g.points.map((pt) => ({ x: clamp(pt.x + dx + adjX), y: clamp(pt.y + dy + adjY) })) });
    } else {
      // 单顶点：端点对接 / 吸边 / 水平垂直对齐（含自身灯带其余顶点，可拉出垂直/水平段）
      const m = /^p:(\d+)$/.exec(ctx.part);
      const idx = m ? Number(m[1]) : -1;
      if (idx < 0 || idx >= g.points.length) return;
      const s = computeSnap(p.x, p.y, ctx.id, [0, 100], idx);
      hint = { gx: s.gx, gy: s.gy, vertex: s.vertex };
      patch = () => ({ ...g, points: g.points.map((pt, j) => (j === idx ? { x: clamp(s.x), y: clamp(s.y) } : { ...pt })) });
    }

    setDevices((ds) => ds.map((d) => (d.vDeviceId === ctx.id ? { ...d, position: patch(d.position!) } : d)));
    setSnapHint(hint);
    setDirty(true);
  };

  const onPointerUp = () => { drag.current = null; setSnapHint(null); };

  /** 在第 segIdx 段的中点插入新顶点，并立即进入拖动新顶点（加弯折） */
  const insertPoint = (e: React.PointerEvent, d: Device, segIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const g = d.position;
    if (!g || g.kind !== 'segment' || g.points.length >= 32) return;
    const a = g.points[segIdx];
    const b = g.points[segIdx + 1];
    if (!a || !b) return;
    const np: PathPoint = { x: clamp((a.x + b.x) / 2), y: clamp((a.y + b.y) / 2) };
    const points = [...g.points.slice(0, segIdx + 1), np, ...g.points.slice(segIdx + 1)];
    setDevices((ds) => ds.map((x) => (x.vDeviceId !== d.vDeviceId ? x : { ...x, position: { ...g, points } })));
    drag.current = { id: d.vDeviceId, part: `p:${segIdx + 1}`, grabPx: toPct(e), grabPos: { ...g, points } };
    svgRef.current?.setPointerCapture(e.pointerId);
    setDirty(true);
  };

  /** 双击顶点删除（至少保留两个顶点） */
  const removePoint = (d: Device, idx: number) => {
    const g = d.position;
    if (!g || g.kind !== 'segment' || g.points.length <= 2) return;
    const points = g.points.filter((_, j) => j !== idx);
    setDevices((ds) => ds.map((x) => (x.vDeviceId !== d.vDeviceId ? x : { ...x, position: { ...g, points } })));
    setDirty(true);
  };

  const setElev = (id: string, elev: number) => {
    setDevices((ds) => ds.map((d) => {
      if (d.vDeviceId !== id) return d;
      return { ...d, position: d.position ? ({ ...d.position, elev } as Pos) : d.position };
    }));
    setDirty(true);
  };

  const setR = (id: string, r: number) => {
    setDevices((ds) => ds.map((d) => {
      if (d.vDeviceId !== id || d.position?.kind !== 'circle') return d;
      return { ...d, position: { ...d.position, r } };
    }));
    setDirty(true);
  };

  const setShapeField = (k: 'w' | 'h' | 'depth', v: number) => {
    setShape((s) => ({ ...s, [k]: v }));
    setDirty(true);
  };

  const save = async (): Promise<boolean> => {
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
      return true;
    } catch (e: any) {
      alert(`保存失败: ${e.message}`);
      return false;
    }
  };

  const finish = async () => {
    if (dirty) {
      const ok = await save();
      if (!ok) return;
    }
    onDone();
  };

  // 高度口径：UI 以“距顶”呈现（0 = 贴顶，越大越靠近地面）；存储 elev 仍为离地百分比
  const elevLabel = (e: number) => `距顶 ${toM(100 - e)}m`;

  // 尺寸行：米数输入框（拖手柄粗调之外的第二通道，键入精调）
  const sizeRow = (label: string, units: number, min: number, max: number, onChange: (v: number) => void) => (
    <label key={label} className={styles.panelRow}>
      <span className={styles.panelLabel}>{label}</span>
      <NumField value={Number((units * UNIT).toFixed(1))} min={min * UNIT} max={max * UNIT}
        onCommit={(m) => onChange(clamp(m / UNIT, min, max))} />
    </label>
  );

  // 半径行：仅吸顶灯，数字输入维护（米）；min/max 与 2D 手柄、3D 渲染一致
  const radiusRow = (d: Device) => {
    if (d.position?.kind !== 'circle') return null;
    return (
      <label key={`${d.vDeviceId}-r`} className={styles.panelRow} title={`${d.name} · 半径`}>
        <span className={`${styles.panelLabel} ${styles.panelSubLabel}`}>└ 半径</span>
        <NumField value={Number((d.position.r * UNIT).toFixed(1))} min={3 * UNIT} max={30 * UNIT}
          onCommit={(m) => setR(d.vDeviceId, clamp(m / UNIT, 3, 30))} />
      </label>
    );
  };

  // 安装高度行：输入框为距顶米数（存储 elev 仍为离地百分比）
  const elevRow = (d: Device) => {
    const drop = 100 - (d.position?.elev ?? 0);
    return (
      <label key={d.vDeviceId} className={styles.panelRow} title={d.name}>
        <span className={styles.panelLabel}>{d.name}</span>
        <NumField value={Number((drop * UNIT).toFixed(1))} min={0} max={100 * UNIT}
          onCommit={(m) => setElev(d.vDeviceId, 100 - clamp(m / UNIT, 0, 100))} />
      </label>
    );
  };

  return (
    <div className={styles.editorLayout}>
      <div className={styles.editorStage}>
        <svg
          ref={svgRef}
          className={styles.svg}
          viewBox={`0 0 ${VW} ${VH}`}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        >
          <rect x={4} y={4} width={VW - 8} height={VH - 8} rx={14} className={styles.planFloor} />
          {Array.from({ length: 9 }, (_, i) => (
            <line key={`v${i}`} x1={(VW / 10) * (i + 1)} y1={8} x2={(VW / 10) * (i + 1)} y2={VH - 8} className={styles.planGrid} />
          ))}
          {Array.from({ length: 3 }, (_, i) => (
            <line key={`h${i}`} x1={8} y1={(VH / 4) * (i + 1)} x2={VW - 8} y2={(VH / 4) * (i + 1)} className={styles.planGrid} />
          ))}

          {devices.map((d) => {
            const p = d.position;
            if (!p) return null;
            const op = d.online ? 1 : 0.55;
            const elev = p.elev ?? 0;

            if (p.kind === 'segment') {
              // 软带路径：折线主体 + 顶点手柄（拖动弯折/双击删除）+ 段中点插入手柄
              const pts = p.points;
              const pathD = pts.map((pt, idx) => `${idx ? 'L' : 'M'}${sx(pt.x)},${sy(pt.y)}`).join(' ');
              const cx = pts.reduce((s, pt) => s + pt.x, 0) / pts.length;
              const cy = pts.reduce((s, pt) => s + pt.y, 0) / pts.length;
              return (
                <g key={d.vDeviceId} data-dev-id={d.vDeviceId} opacity={op} className={styles.draggable}
                  onPointerDown={(e) => onPointerDown(e, d, 'body')}>
                  <path d={pathD} stroke="#7c3aed" strokeWidth={26} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <path d={pathD} stroke="#c4b5fd" strokeWidth={12} fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  <text x={sx(cx)} y={sy(cy) + 6} textAnchor="middle" fontSize={24}
                    className={styles.planText} style={{ pointerEvents: 'none' }}>{d.name}（{elevLabel(elev)}）</text>
                  {pts.map((pt, idx) => (
                    <circle key={`v${idx}`} cx={sx(pt.x)} cy={sy(pt.y)} r={15} fill="#8b5cf6" stroke="#0b1020" strokeWidth={4}
                      className={styles.handle}
                      onPointerDown={(e) => onPointerDown(e, d, `p:${idx}`)}
                      onDoubleClick={(e) => { e.stopPropagation(); removePoint(d, idx); }} />
                  ))}
                  {pts.slice(0, -1).map((a, idx) => {
                    const b = pts[idx + 1];
                    return (
                      <circle key={`m${idx}`} cx={(sx(a.x) + sx(b.x)) / 2} cy={(sy(a.y) + sy(b.y)) / 2} r={9}
                        fill="rgba(139,92,246,0.3)" stroke="#a78bfa" strokeWidth={3} strokeDasharray="5 4"
                        className={styles.handleMid}
                        onPointerDown={(e) => insertPoint(e, d, idx)} />
                    );
                  })}
                </g>
              );
            }

            if (p.kind === 'circle') {
              return (
                <g key={d.vDeviceId} data-dev-id={d.vDeviceId} opacity={op} className={styles.draggable}
                  onPointerDown={(e) => onPointerDown(e, d, 'body')}>
                  <circle cx={sx(p.x)} cy={sy(p.y)} r={sr(p.r)} fill="#fbbf24" stroke="#f59e0b" strokeWidth={4} opacity={0.9} />
                  <circle cx={sx(p.x)} cy={sy(p.y)} r={sr(p.r * 0.45)} fill="#fffbeb" opacity={0.65} />
                  <text x={sx(p.x)} y={sy(p.y) + sr(p.r) + 28} textAnchor="middle" fontSize={24}
                    className={styles.planTextWarm}>{d.name}（{elevLabel(elev)}）</text>
                  <circle cx={sx(p.x + p.r)} cy={sy(p.y)} r={14} fill="#f59e0b" stroke="#0b1020" strokeWidth={4}
                    className={`${styles.handle} ${styles.handleResize}`} onPointerDown={(e) => onPointerDown(e, d, 'resize')} />
                </g>
              );
            }

            return null;
          })}

          {/* 吸附提示：对齐参考线 + 端点对接高亮圈 */}
          {snapHint?.gx != null && (
            <line x1={sx(snapHint.gx)} y1={0} x2={sx(snapHint.gx)} y2={VH} className={styles.snapGuide} />
          )}
          {snapHint?.gy != null && (
            <line x1={0} y1={sy(snapHint.gy)} x2={VW} y2={sy(snapHint.gy)} className={styles.snapGuide} />
          )}
          {snapHint?.vertex && (
            <circle cx={sx(snapHint.vertex.x)} cy={sy(snapHint.vertex.y)} r={20} className={styles.snapTarget} />
          )}
        </svg>
        <div className={styles.editorHint}>
          吸顶灯 = 圆盘（拖动移动，右侧手柄调大小） · 灯带 = 可弯折软带（拖顶点变形 · 拖段间虚线圈加顶点 · 双击顶点删除） · 靠近墙边/其他顶点自动吸附对接（绿色线为对齐参考，绿圈为对接点） · 右侧滑杆/输入框调尺寸与距顶高度 · 排除的设备与网关不显示
        </div>
      </div>

      <aside className={styles.editorPanel}>
        <div className={styles.panelHead}>
          <b>布局编辑</b>
          <span className={dirty ? styles.dirtyDot : styles.cleanDot} title={dirty ? '有未保存的修改' : '已保存'} />
        </div>

        <div className={styles.panelGroup}>
          <span className={styles.panelGroupTitle}>房间尺寸（米）</span>
          {sizeRow('宽', shape.w, 40, 200, (v) => setShapeField('w', v))}
          {sizeRow('深', shape.depth, 40, 200, (v) => setShapeField('depth', v))}
          {sizeRow('高', shape.h, 25, 60, (v) => setShapeField('h', v))}
        </div>

        <div className={styles.panelGroup}>
          <span className={styles.panelGroupTitle}>安装位置 · 距顶（米）</span>
          {devices.map((d) => [elevRow(d), radiusRow(d)])}
          {!devices.length && (
            <span className={styles.panelEmpty}>房间内暂无参与布局的灯具</span>
          )}
        </div>

        <div className={styles.panelActions}>
          <button type="button" className={dirty ? styles.saveBtn : styles.saveBtnDone} disabled={!dirty} onClick={save}>
            {dirty ? '保存布局' : '已保存'}
          </button>
          <button type="button" className={styles.doneBtn} onClick={finish}>完成 · 返回 3D 预览</button>
        </div>
      </aside>
    </div>
  );
}

// ---- 设备清单侧栏 ----
function DeviceList({ room, onToggleExclude }: {
  room: Room;
  onToggleExclude: (deviceId: string) => void;
}) {
  return (
    <aside className={styles.devicePanel}>
      <div className={styles.panelHead}>
        <b>设备清单</b>
        <span className={styles.panelCount}>{room.devices.length}</span>
      </div>
      <ul className={styles.deviceList}>
        {room.devices.map((d) => {
          const k = kindOf(d);
          return (
            <li key={d.vDeviceId} className={`${styles.deviceItem} ${d.excluded ? styles.deviceItemExcluded : ''}`}>
              <span className={`${styles.deviceGlyph} ${styles[`glyph_${k}`]}`}>
                {k === 'circle' ? <GlyphCircle /> : k === 'segment' ? <GlyphStrip /> : <GlyphPoint />}
              </span>
              <span className={styles.deviceMeta}>
                <span className={styles.deviceName}>{d.name}</span>
                <span className={styles.deviceSub}>
                  {KIND_LABEL[k]} · {d.type ?? '未知品类'}
                  {k !== 'point' && d.position?.elev != null ? ` · 距顶 ${toM(100 - d.position.elev)}m` : ''}
                  {d.excluded ? ' · 已排除' : ''}
                </span>
              </span>
              {isPositioned(d) && (
                <button
                  type="button"
                  className={styles.excludeBtn}
                  title={d.excluded ? '恢复参与空间布局' : '从空间布局中排除（不参与位置编辑与 3D 渲染）'}
                  onClick={() => onToggleExclude(d.vDeviceId)}
                >
                  {d.excluded ? <GlyphEyeOff /> : <GlyphEye />}
                </button>
              )}
              <span className={d.online ? styles.dotOn : styles.dotOff} title={d.online ? '在线' : '离线'} />
            </li>
          );
        })}
      </ul>
      {!room.devices.length && <div className={styles.empty}>房间暂无设备</div>}
    </aside>
  );
}

// ---- 房间页：3D 预览（默认）+ 二维编辑 ----
function RoomView({ home, room, onBack, onSaved, onShapeSaved, onToggleExclude }: {
  home: Home | undefined;
  room: Room | undefined;
  onBack: () => void;
  onSaved: (gpno: number, positions: Record<string, Pos>) => void;
  onShapeSaved: (gpno: number, shape: RoomShape) => void;
  onToggleExclude: (gpno: number, deviceId: string) => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  if (!home || !room) return null;
  const online = room.devices.filter((d) => d.online).length;

  return (
    <main className={styles.main}>
      <div className={styles.breadcrumb}>
        <button type="button" className={styles.crumbBack} onClick={onBack}>
          <GlyphArrowLeft />
          {home.name}
        </button>
        <span className={styles.crumbSep}>/</span>
        <h2 className={styles.roomTitle}>{room.name}</h2>
        <span className={styles.roomMeta}>
          {toM(room.shape.w)}×{toM(room.shape.depth)}×{toM(room.shape.h)}m · {online}/{room.devices.length} 在线
        </span>
        <div className={styles.roomActions}>
          {mode === 'view' ? (
            <button type="button" className={styles.btnPrimary} onClick={() => setMode('edit')}>
              <GlyphPencil />
              编辑布局
            </button>
          ) : (
            <button type="button" className={styles.btnGhost} onClick={() => setMode('view')}>
              返回 3D 预览
            </button>
          )}
        </div>
      </div>

      {mode === 'view' ? (
        <div className={styles.roomLayout}>
          <div className={styles.stagePanel}>
            <RoomScene3D key={room.gpno} room={room} />
          </div>
          <DeviceList room={room} onToggleExclude={(id) => onToggleExclude(room.gpno, id)} />
        </div>
      ) : (
        <RoomEditor
          room={room}
          projectCode={home.projectCode}
          onSaved={onSaved}
          onShapeSaved={onShapeSaved}
          onDone={() => setMode('view')}
        />
      )}
    </main>
  );
}

export default function IndexPage() {
  const [homes, setHomes] = useState<Home[]>([]);
  const [activeHome, setActiveHome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<{ kind: 'home' } | { kind: 'room'; gpno: number }>({ kind: 'home' });
  // 本地快照状态：source='local' 表示当前展示的是本地数据；syncing/justSynced 驱动同步按钮反馈
  const [syncInfo, setSyncInfo] = useState<{ source: 'local' | 'remote'; syncedAt: string | null } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [justSynced, setJustSynced] = useState(false);

  const applyTree = (payload: { source: 'local' | 'remote'; syncedAt: string | null; tree: Home[] }) => {
    setSyncInfo({ source: payload.source, syncedAt: payload.syncedAt });
    // 灯带旧数据（两点直线）统一归一化为折线路径
    setHomes(payload.tree.map((h) => ({
      ...h,
      rooms: h.rooms.map((r) => ({
        ...r,
        devices: r.devices.map((d) => ({ ...d, position: normalizePos(d.position) })),
      })),
    })));
    setActiveHome((prev) => {
      if (prev && payload.tree.some((h) => h.projectCode === prev)) return prev;
      const first = payload.tree.find((h) => (h.deviceCount ?? 0) > 0) ?? payload.tree[0];
      return first ? first.projectCode : prev;
    });
  };

  /** 加载三层结构（本地快照优先，零云端请求） */
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      applyTree(await api('/tree'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  /** 一键同步：拉取欧享家云端最新结构写入本地快照 */
  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      setError(null);
      applyTree(await api('/sync', { method: 'POST' }));
      setJustSynced(true);
      setTimeout(() => setJustSynced(false), 2000);
    } catch (e: any) {
      // 同步是唯一依赖云端 token 的操作，token 提示仅在此处展示
      setError(`同步失败：${e.message}（token 可能失效，请重新抓包更新）`);
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => { load(); }, []);

  const home = homes.find((h) => h.projectCode === activeHome);
  const room = view.kind === 'room' ? home?.rooms.find((r) => r.gpno === view.gpno) : undefined;

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

  /** 切换设备是否参与空间模型（排除/恢复），持久化到 positions 文件的 excluded 列表 */
  const onToggleExclude = async (gpno: number, deviceId: string) => {
    if (!home) return;
    const target = home.rooms.find((r) => r.gpno === gpno);
    if (!target) return;
    // 计算排除后的全量 id 列表：目标设备取反，其余保持
    const next = target.devices
      .filter((d) => (d.vDeviceId === deviceId ? !d.excluded : d.excluded))
      .map((d) => d.vDeviceId);
    try {
      await api('/positions', {
        method: 'POST',
        body: JSON.stringify({ projectCode: home.projectCode, gpno, excluded: next }),
      });
      setHomes((hs) => hs.map((h) => {
        if (h.projectCode !== home.projectCode) return h;
        return {
          ...h,
          rooms: h.rooms.map((r) => (r.gpno !== gpno ? r : {
            ...r,
            devices: r.devices.map((d) => (d.vDeviceId === deviceId ? { ...d, excluded: !d.excluded } : d)),
          })),
        };
      }));
    } catch (e: any) {
      alert(`更新失败: ${e.message}`);
    }
  };

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <div className={styles.brand}>
            <span className={styles.brandMark}><GlyphHouse /></span>
            <span className={styles.brandText}>
              <b>欧享家</b>
              <i>家庭设备管理台</i>
            </span>
          </div>

          {homes.length > 0 && (
            <nav className={styles.homeSwitch}>
              {homes.map((h) => (
                <button
                  key={h.projectCode}
                  type="button"
                  className={`${styles.homePill} ${h.projectCode === activeHome ? styles.homePillActive : ''}`}
                  onClick={() => { setActiveHome(h.projectCode); setView({ kind: 'home' }); }}
                >
                  {h.name}
                  <span className={styles.pillCount}>
                    {h.onlineCount != null ? `${h.onlineCount}/${h.deviceCount}` : h.deviceCount}
                  </span>
                </button>
              ))}
            </nav>
          )}

          <div className={styles.topActions}>
            <span
              className={styles.syncMeta}
              title={syncInfo?.source === 'local' ? '当前展示本地快照，位置编辑实时保存' : '当前数据直接来自欧享家云端'}
            >
              <span className={`${styles.sourceDot} ${syncInfo?.source === 'remote' ? styles.dotRemote : styles.dotLocal}`} />
              {syncInfo?.source === 'remote' ? '云端数据' : '本地快照'} · {fmtTime(syncInfo?.syncedAt ?? null)}
            </span>
            <button
              type="button"
              className={justSynced ? styles.syncBtnDone : styles.syncBtn}
              onClick={sync}
              disabled={syncing}
              title="从欧享家云端拉取最新的家庭/房间/设备结构到本地快照"
            >
              <span className={syncing ? styles.spin : undefined}><GlyphSync /></span>
              {syncing ? '同步中…' : justSynced ? '已同步' : '同步数据'}
            </button>
            <button type="button" className={styles.refreshBtn} onClick={load} disabled={loading} title="重新读取本地快照">
              <span className={loading ? styles.spin : undefined}><GlyphRefresh /></span>
              刷新
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className={styles.errorBanner}>
          <b>数据加载失败：</b>{error}
        </div>
      )}
      {loading && !homes.length && !error && <div className={styles.loadingTip}>正在加载家庭数据…</div>}

      {view.kind === 'home' ? (
        <HomeView home={home} onOpenRoom={(gpno) => setView({ kind: 'room', gpno })} />
      ) : (
        <RoomView
          home={home}
          room={room}
          onBack={() => setView({ kind: 'home' })}
          onSaved={onSaved}
          onShapeSaved={onShapeSaved}
          onToggleExclude={onToggleExclude}
        />
      )}
    </div>
  );
}
