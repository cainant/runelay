import { animate, inView, stagger } from "motion";

const spring = { type: "spring", stiffness: 420, damping: 34 };
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const quick = { duration: 0.12 };

for (const element of document.querySelectorAll("[data-reveal]")) {
  inView(
    element,
    () => {
      element.classList.add("drawn");
      if (reduced) return void animate(element, { opacity: 1 }, quick);
      animate(element, { opacity: [0, 1], y: [16, 0], filter: ["blur(6px)", "blur(0px)"] }, spring);
      const tiles = element.matches(".cta") && element.querySelectorAll(".stack img");
      if (tiles) animate(tiles, { x: [-10, 0], scale: [0.6, 1] }, { ...spring, delay: stagger(0.06) });
      const lines = element.matches(".terminal") && element.querySelectorAll(".out");
      if (lines) animate(lines, { opacity: [0, 1], x: [-6, 0] }, { duration: 0.3, delay: stagger(0.45, { startDelay: 0.5 }) });
    },
    { amount: 0.4 },
  );
}

for (const details of document.querySelectorAll(".faq details")) {
  const answer = details.querySelector(".answer");
  details.querySelector("summary").addEventListener("click", (event) => {
    event.preventDefault();
    const opening = details.dataset.state !== "open";
    details.dataset.state = opening ? "open" : "closed";
    if (opening) details.open = true;
    const from = answer.offsetHeight;
    const to = opening ? answer.scrollHeight : 0;
    const motion = animate(
      answer,
      { height: [opening ? 0 : from, to], opacity: opening ? [0, 1] : 0, filter: opening ? ["blur(4px)", "blur(0px)"] : "blur(4px)" },
      reduced ? quick : spring,
    );
    motion.then(() => {
      if (details.dataset.state === "closed") details.open = false;
      else answer.style.height = "auto";
    });
  });
}

for (const button of document.querySelectorAll("[data-copy], [data-copy-from]")) {
  const label = button.querySelector("[data-label]") ?? button;
  const original = label.textContent;
  let timer;
  button.addEventListener("click", () => {
    const source = button.dataset.copyFrom ? document.querySelector(button.dataset.copyFrom) : null;
    const text = button.dataset.copy ?? (source?.content ?? source)?.textContent ?? "";
    navigator.clipboard.writeText(text.trim());
    label.textContent = button.dataset.copied;
    clearTimeout(timer);
    timer = setTimeout(() => {
      label.textContent = original;
    }, 1600);
  });
}

const versionSlots = document.querySelectorAll("[data-version]");
if (versionSlots.length) {
  fetch("https://api.github.com/repos/runelay/runelay/releases/latest")
    .then((response) => (response.ok ? response.json() : null))
    .then((release) => {
      if (!release?.tag_name) return;
      for (const slot of versionSlots) slot.textContent = ` · ${release.tag_name.replace(/^v/, "")}`;
    })
    .catch(() => null);
}

const PIXEL_TONES = [["255, 214, 180", 0.16], ["255, 196, 150", 0.12], ["70, 24, 4", 0.2], ["50, 16, 2", 0.16], ["255, 255, 255", 0.1]];

const drawPixels = (canvas) => {
  const context = canvas.getContext("2d");
  if (!context) return;
  let cells = [];
  let width = 0;
  let height = 0;
  let visible = true;
  let frame = 0;

  const layout = () => {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const step = width < 560 ? 8 : 10;
    const size = width < 560 ? 4 : 5;
    const reach = Math.min(width, height) * 0.5;
    cells = [];
    for (let y = step / 2; y < height; y += step) {
      for (let x = step / 2; x < width; x += step) {
        const edge = Math.min(x, width - x, y, height - y) / reach;
        const density = Math.max(0, 1 - edge * 1.15) ** 3.2 * 0.6;
        const seed = Math.random();
        if (seed > density + 0.1) continue;
        const roll = Math.random();
        const tone = roll < 0.05 ? 4 : Math.floor(Math.random() * 4);
        cells.push({ x: x - size / 2, y: y - size / 2, size, density, seed, tone, phase: Math.random() * Math.PI * 2, speed: 0.15 + Math.random() * 0.35 });
      }
    }
  };

  const paint = (time) => {
    context.clearRect(0, 0, width, height);
    const t = time / 1000;
    for (const cell of cells) {
      const wave = Math.sin((cell.x + cell.y * 0.6) / 180 - t * 0.3) * 0.5 + 0.5;
      const flicker = Math.sin(t * cell.speed + cell.phase) * 0.5 + 0.5;
      const presence = cell.density + wave * 0.12 - cell.seed;
      if (presence <= 0) continue;
      const [rgb, peak] = PIXEL_TONES[cell.tone];
      const alpha = Math.min(1, presence * 3) * (0.6 + flicker * 0.4) * peak;
      context.fillStyle = `rgba(${rgb}, ${alpha.toFixed(3)})`;
      context.fillRect(cell.x, cell.y, cell.size, cell.size);
    }
  };

  const loop = (time) => {
    frame = 0;
    if (!visible || document.hidden) return;
    paint(time);
    frame = requestAnimationFrame(loop);
  };

  const start = () => {
    if (reduced) return paint(0);
    if (!frame) frame = requestAnimationFrame(loop);
  };

  new ResizeObserver(() => {
    layout();
    paint(performance.now());
  }).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting);
    if (visible) start();
  }).observe(canvas);
  document.addEventListener("visibilitychange", () => !document.hidden && visible && start());
};

for (const canvas of document.querySelectorAll(".hero-pixels")) drawPixels(canvas);

const hero = document.querySelector(".shot-hero");
if (hero) inView(hero, () => void hero.classList.add("is-in"), { amount: 0.25 });

for (const bento of document.querySelectorAll(".bento")) {
  const cards = bento.querySelectorAll(".bento-card");
  inView(
    bento,
    () => {
      if (reduced) return void animate(cards, { opacity: 1 }, quick);
      animate(cards, { opacity: [0, 1], y: [24, 0] }, { duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: stagger(0.07) });
    },
    { amount: 0.15 },
  );
}

const showcases = document.querySelectorAll("[data-showcase]");
if (showcases.length) {
  try {
    localStorage.setItem("runelay-locale", document.documentElement.lang.startsWith("pt") ? "pt-BR" : "en");
    localStorage.setItem("runelay-sound", "off");
  } catch {}
  let showcase;
  const load = () => (showcase ??= import("./showcase/index.tsx"));
  for (const host of showcases) {
    const mount = () => load().then((module) => module.mount(host));
    if (host.dataset.showcase === "hero") {
      const idle = () => (window.requestIdleCallback ?? setTimeout)(mount);
      if (document.readyState === "complete") idle();
      else addEventListener("load", idle, { once: true });
      continue;
    }
    inView(host, () => void load(), { margin: "0px 0px 600px 0px" });
    inView(host, () => void mount(), { amount: 0.35 });
  }
}
