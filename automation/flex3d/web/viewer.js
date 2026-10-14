import * as THREE from "three";
import { OrbitControls } from "/vendor/OrbitControls.js";

const UI = {
  zh: {
    help: "拖动旋转整台机器，滚轮缩放，右键平移。点右侧步骤，左边停在那一步。",
    play: "播放",
    pause: "暂停",
    lang: "English",
    time: "时间",
    empty: "还没有命令。",
    fail: "打不开",
    noKey: "地址里没有 key，服务上也没有已加载的协议。",
    linked: (n, c, type) => `步骤 ${n} → 命令 ${c} ${type}`,
    matched: "与分析 JSON 对得上",
    mismatched: "commandId 对不上",
    noCommand: (n) => `步骤 ${n} 没有对应命令`,
    stepOnly: (n) => `步骤 ${n}`,
    home: "回原点",
    pickUpTip: "取枪头",
    aspirate: "吸液",
    mixAspirate: "混匀·吸",
    dispense: "分液",
    mixDispense: "混匀·打",
    moveToAddressableAreaForDropTip: "移到垃圾桶",
    moveToAddressableArea: "移到",
    dropTip: "弃枪头",
    moveGrip: "夹爪搬运",
    moveHand: "手动移动",
    loadLiquid: "加载液体",
  },
  en: {
    help: "Drag to rotate the machine, scroll to zoom, right-drag to pan. Click a step on the right and the left view stops on that step.",
    play: "Play",
    pause: "Pause",
    lang: "中文",
    time: "Time",
    empty: "No command yet.",
    fail: "Could not open",
    noKey: "The address has no key and the server has no loaded protocol.",
    linked: (n, c, type) => `Step ${n} → command ${c} ${type}`,
    matched: "Matches the analysis JSON",
    mismatched: "commandId does not match",
    noCommand: (n) => `Step ${n} has no command`,
    stepOnly: (n) => `Step ${n}`,
    home: "Home",
    pickUpTip: "Pick up tip",
    aspirate: "Aspirate",
    mixAspirate: "Mix, aspirate",
    dispense: "Dispense",
    mixDispense: "Mix, dispense",
    moveToAddressableAreaForDropTip: "Move to trash",
    moveToAddressableArea: "Move to",
    dropTip: "Drop tip",
    moveGrip: "Move with gripper",
    moveHand: "Move by hand",
    loadLiquid: "Load liquid",
  },
};

const params = new URLSearchParams(location.search);
// Reassignable: when the address arrives without ?key= the page adopts the
// model the server has loaded (see adoptRegisteredKey) instead of failing.
let key = params.get("key");
const stepsEl = document.getElementById("steps");
const commandEl = document.getElementById("command");
const timeEl = document.getElementById("time");
const stage = document.getElementById("stage");
const titleEl = document.getElementById("title");
const playBtn = document.getElementById("play");
const langBtn = document.getElementById("lang");

let lang = "zh";
let info = null;
let commands = [];
let view = null;
let selected = 0;
let detailed = true;
let broken = null;
let t = 0;
let playing = false;
let lastNow = 0;
const bodyMatrix = new Map();
const dynObjects = [];

function ui() {
  return UI[lang];
}

function renderChrome() {
  const text = ui();
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.body.classList.toggle("en", lang === "en");
  document.getElementById("help").textContent = text.help;
  document.getElementById("time-label").textContent = text.time;
  langBtn.textContent = text.lang;
  playBtn.textContent = playing ? text.pause : text.play;
  if (broken === "nokey") {
    titleEl.textContent = text.fail;
    commandEl.textContent = text.noKey;
    commandEl.className = "bad";
  } else if (broken) {
    titleEl.textContent = text.fail;
    commandEl.textContent = broken;
    commandEl.className = "bad";
  } else if (!info) {
    commandEl.textContent = text.empty;
    commandEl.className = "";
  } else {
    paintSteps();
    writeCommand(selected, detailed);
  }
}

function stepVerb(step) {
  const text = ui();
  const raw = step.text || "";
  if (step.kind === "aspirate") return raw.includes("混匀") ? text.mixAspirate : text.aspirate;
  if (step.kind === "dispense") return raw.includes("混匀") ? text.mixDispense : text.dispense;
  if (step.kind === "moveLabware") return raw.includes("夹爪") ? text.moveGrip : text.moveHand;
  if (step.kind === "dropTip" || step.kind === "dropTipInPlace") return text.dropTip;
  return text[step.kind] || step.kind;
}

function stepTail(step) {
  const raw = (step.text || "").trim();
  const cut = {
    home: /^回原点(?:\s*\(home\))?/,
    pickUpTip: /^取枪头/,
    aspirate: /^(?:混匀·吸|吸液)/,
    dispense: /^(?:混匀·打|分液)/,
    moveToAddressableAreaForDropTip: /^移到垃圾桶/,
    moveToAddressableArea: /^移到/,
    dropTipInPlace: /^弃枪头/,
    dropTip: /^弃枪头/,
    moveLabware: /^(?:夹爪搬运|手动移动)/,
    loadLiquid: /^加载液体/,
  }[step.kind];
  // The captions double-space around arrows for the JPEG title card; the list shows single spaces.
  return (cut ? raw.replace(cut, "") : raw).replace(/\s+/g, " ").trim();
}

function stepLine(step) {
  const verb = stepVerb(step);
  const tail = stepTail(step);
  return tail && tail !== verb ? `${verb} ${tail}` : verb;
}

function paintSteps() {
  if (!info) return;
  [...stepsEl.children].forEach((item, index) => {
    item.firstChild.textContent = stepLine(info.steps[index]);
  });
}

function fail(text) {
  broken = text;
  renderChrome();
}

function mark(index) {
  selected = index;
  [...stepsEl.children].forEach((item, i) => {
    const on = i === index;
    item.classList.toggle("on", on);
    if (on) item.scrollIntoView({ block: "nearest" });
  });
}

function writeCommand(index, withMatch) {
  detailed = withMatch;
  const text = ui();
  const step = info.steps[index];
  const command = commands[step ? step.cmd : -1];
  const n = index + 1;
  if (!command) {
    commandEl.className = withMatch ? "bad" : "";
    commandEl.textContent = withMatch ? text.noCommand(n) : text.stepOnly(n);
    return;
  }
  const same = !step.commandId || command.id === step.commandId;
  let body = `${text.linked(n, step.cmd + 1, command.commandType)}\nid ${command.id || "-"}\n${JSON.stringify(command.params || {}, null, 2)}`;
  if (withMatch) body += `\n${same ? text.matched : text.mismatched}`;
  commandEl.className = withMatch && !same ? "bad" : "";
  commandEl.textContent = body;
}

function quat(mesh, q) {
  mesh.quaternion.set(q[1], q[2], q[3], q[0]);
}

function geometry(geom, meshes) {
  const s = geom.size;
  if (geom.type === "box") return new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2);
  if (geom.type === "sphere") return new THREE.SphereGeometry(s[0], 24, 16);
  if (geom.type === "plane") return new THREE.PlaneGeometry(s[0] * 2, s[1] * 2);
  if (geom.type === "cylinder" || geom.type === "capsule") {
    const geom3 = new THREE.CylinderGeometry(s[0], s[0], s[1] * 2, geom.type === "capsule" ? 16 : 24);
    geom3.rotateX(Math.PI / 2);
    return geom3;
  }
  const src = meshes[geom.mesh];
  const mesh = new THREE.BufferGeometry();
  mesh.setAttribute("position", new THREE.Float32BufferAttribute(src.positions, 3));
  if (src.uv) mesh.setAttribute("uv", new THREE.Float32BufferAttribute(src.uv, 2));
  mesh.setIndex(src.indices);
  mesh.computeVertexNormals();
  return mesh;
}

function bodyMatrixFrom(twelve) {
  const m = new THREE.Matrix4();
  const x = twelve;
  m.set(
    x[3], x[4], x[5], x[0],
    x[6], x[7], x[8], x[1],
    x[9], x[10], x[11], x[2],
    0, 0, 0, 1,
  );
  return m;
}

function applyFrame(frame) {
  for (const [id, twelve] of Object.entries(frame.bodies)) {
    const holder = bodyMatrix.get(Number(id));
    if (holder) holder.matrix.copy(bodyMatrixFrom(twelve));
  }
  frame.dyn.forEach((pack, index) => {
    const mesh = dynObjects[index];
    if (!mesh) return;
    mesh.position.set(pack[0], pack[1], pack[2]);
    const alpha = pack[9];
    mesh.visible = alpha > 0.02;
    const ratio = (next, base) => (Math.abs(base) > 1e-8 ? next / base : 1);
    if (mesh.userData.kind === "box") mesh.scale.set(ratio(pack[3], mesh.userData.base[0]), ratio(pack[4], mesh.userData.base[1]), ratio(pack[5], mesh.userData.base[2]));
    else if (mesh.userData.kind === "cylinder" || mesh.userData.kind === "capsule") {
      const radial = ratio(pack[3], mesh.userData.base[0]);
      mesh.scale.set(radial, radial, ratio(pack[4], mesh.userData.base[1]));
    } else if (mesh.userData.kind === "sphere") {
      const k = pack[3] / mesh.userData.base[0];
      mesh.scale.set(k, k, k);
    }
    if (mesh.material) {
      mesh.material.color.setRGB(pack[6], pack[7], pack[8], THREE.SRGBColorSpace);
      mesh.material.opacity = alpha;
      mesh.material.transparent = alpha < 0.99;
    }
  });
}

function poseAt(time) {
  const frames = view.frames;
  if (!frames.length) return;
  if (time <= frames[0].t) {
    applyFrame(frames[0]);
    return;
  }
  const last = frames[frames.length - 1];
  if (time >= last.t) {
    applyFrame(last);
    return;
  }
  let hi = 1;
  while (hi < frames.length && frames[hi].t < time) hi += 1;
  const a = frames[hi - 1];
  const b = frames[hi];
  const span = b.t - a.t;
  const u = span > 1e-6 ? (time - a.t) / span : 1;
  const mixed = { bodies: {}, dyn: [] };
  const ids = new Set([...Object.keys(a.bodies), ...Object.keys(b.bodies)]);
  for (const id of ids) {
    const left = a.bodies[id] || view.home[id];
    const right = b.bodies[id] || left;
    mixed.bodies[id] = left.map((value, i) => value + (right[i] - value) * u);
  }
  for (let i = 0; i < a.dyn.length; i += 1) {
    mixed.dyn.push(a.dyn[i].map((value, k) => value + (b.dyn[i][k] - value) * u));
  }
  applyFrame(mixed);
}

function select(index) {
  playing = false;
  lastNow = 0;
  const step = info.steps[index];
  t = step ? step.t0 : 0;
  timeEl.value = String(t);
  mark(index);
  writeCommand(index, true);
  playBtn.textContent = ui().play;
  poseAt(t);
}

function followTime() {
  let index = 0;
  info.steps.forEach((step, i) => {
    if (step.kind !== "loadLiquid" && step.t0 <= t + 1e-3) index = i;
  });
  if (index !== selected) {
    mark(index);
    writeCommand(index, false);
  }
  poseAt(t);
}

function mount(payload) {
  view = payload;
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.02, 30);
  const target = new THREE.Vector3(...payload.camera.target);
  camera.up.set(0, 0, 1);
  camera.position.set(...payload.camera.position);
  camera.lookAt(target);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true;
  scene.add(new THREE.AmbientLight(0xffffff, 0.95));
  const sun = new THREE.DirectionalLight(0xffffff, 1.05);
  sun.position.set(2, -3, 4);
  scene.add(sun);
  const maps = (payload.textures || []).map((item) => {
    const map = new THREE.TextureLoader().load(`/flex3d/${key}/assets/${item.file}`);
    map.colorSpace = THREE.SRGBColorSpace;
    if (item.file !== "deck.png") {
      map.wrapT = THREE.RepeatWrapping;
      map.repeat.y = -1;
      map.offset.y = 1;
    }
    return map;
  });

  for (const [id, twelve] of Object.entries(payload.home)) {
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(bodyMatrixFrom(twelve));
    bodyMatrix.set(Number(id), holder);
    scene.add(holder);
  }
  const dynIndex = new Map(payload.dynamic.map((gid, index) => [gid, index]));
  for (const geom of payload.geoms) {
    const holder = bodyMatrix.get(geom.body);
    if (!holder || geom.rgba[3] <= 0.01 && !dynIndex.has(geom.gid)) continue;
    const map = geom.tex == null ? null : maps[geom.tex];
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setRGB(geom.rgba[0], geom.rgba[1], geom.rgba[2], THREE.SRGBColorSpace),
      map,
      emissive: new THREE.Color(geom.emission > 0.05 ? 0xffffff : 0x000000),
      emissiveMap: geom.emission > 0.05 ? map : null,
      emissiveIntensity: geom.emission || 0,
      opacity: geom.rgba[3],
      transparent: geom.rgba[3] < 0.99,
      depthWrite: geom.rgba[3] > 0.9,
      roughness: geom.rgba[3] < 0.5 ? 0.05 : 0.55,
      metalness: 0.04,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry(geom, payload.meshes), material);
    mesh.position.set(...geom.pos);
    quat(mesh, geom.quat);
    mesh.userData.kind = geom.type;
    mesh.userData.base = geom.size.slice();
    holder.add(mesh);
    if (dynIndex.has(geom.gid)) dynObjects[dynIndex.get(geom.gid)] = mesh;
    mesh.visible = geom.rgba[3] > 0.02;
  }
  const fit = new THREE.Box3();
  scene.traverse((obj) => {
    if (obj.isMesh && obj.userData.kind !== "plane" && obj.visible) fit.expandByObject(obj);
  });
  if (!fit.isEmpty()) {
    const center = fit.getCenter(new THREE.Vector3());
    const radius = fit.getSize(new THREE.Vector3()).length() * 0.55;
    camera.position.copy(center).add(new THREE.Vector3(radius * 0.75, -radius * 1.55, radius * 0.55));
    camera.near = Math.max(0.01, radius / 100);
    camera.far = radius * 20;
    controls.target.set(center.x, center.y - radius * 0.08, center.z);
    camera.updateProjectionMatrix();
  }

  function resize() {
    const width = stage.clientWidth || 800;
    const height = stage.clientHeight || 640;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener("resize", resize);
  function frame(now) {
    try {
      if (playing) {
        const end = Number(timeEl.max) || 0;
        const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
        lastNow = now || 0;
        t = Math.min(end, t + dt);
        timeEl.value = String(t);
        followTime();
        if (t >= end) {
          playing = false;
          lastNow = 0;
          playBtn.textContent = ui().play;
        }
      }
      controls.update();
      renderer.render(scene, camera);
    } catch (error) {
      window.__flexError = String(error && error.stack || error);
      playing = false;
      lastNow = 0;
      playBtn.textContent = ui().play;
    }
    requestAnimationFrame(frame);
  }
  frame();
  poseAt(0);
  window.__flex = { camera, controls, scene, renderer };
}

async function adoptRegisteredKey() {
  // The address is easy to hand over without ?key=. Ask which model is loaded
  // and adopt it, so a bare /viewer.html (or an old bookmark) still works.
  try {
    const res = await fetch("/flex3d/health");
    if (!res.ok) return false;
    const health = await res.json();
    const models = Array.isArray(health.models) ? health.models : [];
    if (!models.length) return false;
    key = models[models.length - 1];
    const url = new URL(location.href);
    url.searchParams.set("key", key);
    history.replaceState(null, "", url);
    return true;
  } catch {
    return false;
  }
}

async function boot() {
  if (!key && !(await adoptRegisteredKey())) {
    broken = "nokey";
    renderChrome();
    return;
  }
  const [infoRes, analysisRes, viewRes] = await Promise.all([
    fetch(`/flex3d/${key}/info`),
    fetch(`/flex3d/${key}/analysis.json`),
    fetch(`/flex3d/${key}/view.json`),
  ]);
  if (!infoRes.ok) {
    fail(await infoRes.text());
    return;
  }
  if (!viewRes.ok) {
    fail(await viewRes.text());
    return;
  }
  info = await infoRes.json();
  const analysis = await analysisRes.json();
  commands = analysis.commands || [];
  titleEl.textContent = info.title || "Flex 3D";
  timeEl.max = String(info.duration || 0);
  info.steps.forEach((step, index) => {
    const item = document.createElement("li");
    const text = document.createElement("span");
    item.appendChild(text);
    item.onclick = () => select(index);
    stepsEl.appendChild(item);
  });
  paintSteps();
  mount(await viewRes.json());
  select(0);
}

playBtn.addEventListener("click", () => {
  if (!info || !view) return;
  if (playing) {
    playing = false;
    lastNow = 0;
  } else {
    const end = Number(timeEl.max) || 0;
    if (end <= 0) return;
    if (t >= end - 1e-4) {
      t = 0;
      timeEl.value = "0";
      followTime();
    }
    playing = true;
    lastNow = 0;
  }
  playBtn.textContent = playing ? ui().pause : ui().play;
});

langBtn.addEventListener("click", () => {
  lang = lang === "zh" ? "en" : "zh";
  renderChrome();
});

timeEl.addEventListener("input", () => {
  if (!info) return;
  if (playing) {
    playing = false;
    lastNow = 0;
    playBtn.textContent = ui().play;
  }
  t = Number(timeEl.value);
  followTime();
});

renderChrome();
boot().catch((error) => fail(String(error)));
