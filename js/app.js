// Engine: title screen -> item select -> location select (hexagon carousel)
// -> journey. Once a location starts, the chosen item shows persistently
// in a small inventory slot, top-left, for the rest of the playthrough.

const ITEMS_PATH = "data/items.json";
const LOCATIONS_INDEX_PATH = "data/locations-index.json";
const COMMON_ENDING_PATH = "data/common/ending.json";

const el = {
  loading: document.getElementById("loading"),

  screenTitle: document.getElementById("screen-title"),
  beginBtn: document.getElementById("begin-btn"),

  screenItemSelect: document.getElementById("screen-item-select"),
  itemGrid: document.getElementById("item-grid"),
  itemPreviewCanvas: document.getElementById("item-preview-canvas"),
  itemPreviewFallback: document.getElementById("item-preview-fallback"),
  itemPreviewName: document.getElementById("item-preview-name"),
  bringItemBtn: document.getElementById("bring-item-btn"),

  locationSelect: document.getElementById("screen-location-select"),
  carouselTrack: document.getElementById("carousel-track"),
  carouselPrev: document.getElementById("carousel-prev"),
  carouselNext: document.getElementById("carousel-next"),
  carouselDescription: document.getElementById("carousel-description"),
  choosePathBtn: document.getElementById("choose-path-btn"),

  scene: document.getElementById("scene"),
  canvas: document.getElementById("scene-canvas"),

  inventorySlot: document.getElementById("inventory-slot"),
  inventoryCanvas: document.getElementById("inventory-canvas"),
  inventoryFallback: document.getElementById("inventory-fallback"),

  boxLinear: document.getElementById("box-linear"),
  linearText: document.getElementById("linear-text"),
  linearBtn: document.getElementById("linear-continue"),

  boxLeft: document.getElementById("box-left"),
  leftText: document.getElementById("left-text"),
  leftBtn: document.getElementById("left-continue"),

  boxRight: document.getElementById("box-right"),
  rightText: document.getElementById("right-text"),
  rightBtn: document.getElementById("right-continue"),

  boxEnd: document.getElementById("box-end"),
  endText: document.getElementById("end-text"),
};

let story = null;
let currentId = null;
let ditherStarted = false;
let inventorySetUp = false;
let chosenItem = null;

const imageCache = {};

function init() {
  el.loading.classList.add("hidden");
  el.screenTitle.classList.remove("hidden");
  el.beginBtn.onclick = showItemSelect;
}

// ---------------------------------------------------------------------
// Item select
// ---------------------------------------------------------------------

let items = [];
let selectedItemIndex = null;
let itemBoxes = []; // { element, canvas, renderer }
let previewRenderer = null;

async function showItemSelect() {
  try {
    el.screenTitle.classList.add("hidden");
    el.loading.classList.remove("hidden");

    const res = await fetch(ITEMS_PATH);
    if (!res.ok) {
      throw new Error(`Could not load ${ITEMS_PATH} — status ${res.status}.`);
    }
    const data = await res.json();
    items = data.items;

    el.loading.classList.add("hidden");
    el.screenItemSelect.classList.remove("hidden");
    setupItemGrid();
  } catch (err) {
    showFatalError(err);
  }
}

function setupItemGrid() {
  el.itemGrid.innerHTML = "";
  itemBoxes = [];
  selectedItemIndex = null;
    el.bringItemBtn.disabled = true;
  // A canvas can't get a fresh WebGL context once its old one was shut
  // down, so give the preview a brand new canvas each time.
  const freshPreview = el.itemPreviewCanvas.cloneNode(false);
  el.itemPreviewCanvas.replaceWith(freshPreview);
  el.itemPreviewCanvas = freshPreview;
  el.itemPreviewName.textContent = "Select an item";
  el.itemPreviewCanvas.classList.remove("hidden");
  el.itemPreviewFallback.classList.add("hidden");

  items.forEach((item, i) => {
    const box = document.createElement("div");
    box.className = "item-box";

    const canvas = document.createElement("canvas");
    box.appendChild(canvas);

    const record = { element: box, canvas, renderer: null };

    const img = new Image();
    img.onload = () => {
      const renderer = DitherFactory.create();
      renderer.init(canvas);
      renderer.setImage(img);
      renderer.start();
      record.renderer = renderer;
      record.image = img;
    };
    img.onerror = () => {
      canvas.remove();
      const fallback = document.createElement("div");
      fallback.className = "fallback-label";
      fallback.textContent = item.name;
      box.appendChild(fallback);
    };
    img.src = item.icon;
    record.imgEl = img;

    box.onclick = () => selectItem(i);

    el.itemGrid.appendChild(box);
    itemBoxes.push(record);
  });

  el.bringItemBtn.onclick = () => {
    if (selectedItemIndex === null) return;
    chosenItem = items[selectedItemIndex];
    el.screenItemSelect.classList.add("hidden");

    // These thumbnails are behind us now — release their WebGL contexts
    // rather than leaving them running invisibly for the rest of the session.
    itemBoxes.forEach((box) => box.renderer && box.renderer.dispose());
    if (previewRenderer) {
      previewRenderer.dispose();
      previewRenderer = null;
    }

    showLocationSelect();
  };
}

function selectItem(index) {
  selectedItemIndex = index;
  itemBoxes.forEach((box, i) => box.element.classList.toggle("is-selected", i === index));
  el.bringItemBtn.disabled = false;

  const item = items[index];
  el.itemPreviewName.textContent = item.name;

  const record = itemBoxes[index];
  if (record.imgEl && record.imgEl.complete && record.imgEl.naturalWidth > 0) {
    el.itemPreviewCanvas.classList.remove("hidden");
    el.itemPreviewFallback.classList.add("hidden");
    if (!previewRenderer) {
      previewRenderer = DitherFactory.create();
      previewRenderer.init(el.itemPreviewCanvas);
      previewRenderer.start();
    }
    previewRenderer.setImage(record.imgEl);
  } else {
    el.itemPreviewCanvas.classList.add("hidden");
    el.itemPreviewFallback.textContent = item.name;
    el.itemPreviewFallback.classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------
// Location select (hexagon carousel)
// ---------------------------------------------------------------------

let carouselLocations = [];
let carouselIndex = 0;
let carouselRotationSteps = 0;
let carouselCards = [];
let carouselRadius = 0;
let carouselAngleStep = 0;

async function showLocationSelect() {
  try {
    el.loading.classList.remove("hidden");

    const res = await fetch(LOCATIONS_INDEX_PATH);
    if (!res.ok) {
      throw new Error(`Could not load ${LOCATIONS_INDEX_PATH} — status ${res.status}.`);
    }
    const index = await res.json();

    el.loading.classList.add("hidden");
    el.locationSelect.classList.remove("hidden");
    setupCarousel(index.locations);
  } catch (err) {
    showFatalError(err);
  }
}

function setupCarousel(locations) {
  carouselLocations = locations;
  carouselIndex = 0;
  carouselRotationSteps = 0;
  carouselCards = [];
  el.carouselTrack.innerHTML = "";
  el.choosePathBtn.disabled = false;

  locations.forEach((loc) => {
    const card = document.createElement("div");
    card.className = "location-card";

    const canvas = document.createElement("canvas");
    canvas.className = "location-canvas";
    card.appendChild(canvas);

    const record = { element: card, canvas, renderer: null };

    const img = new Image();
    img.onload = () => {
      const renderer = DitherFactory.create();
      renderer.init(canvas);
      renderer.setImage(img);
      renderer.start();
      record.renderer = renderer;
    };
    img.onerror = () => {
      canvas.remove();
      const fallback = document.createElement("div");
      fallback.className = "fallback-label";
      fallback.textContent = loc.name;
      card.appendChild(fallback);
    };
    img.src = loc.thumbnail;

    card.onclick = () => {
      const idx = carouselLocations.indexOf(loc);
      if (idx !== carouselIndex) {
        goToIndex(idx);
      }
    };

    el.carouselTrack.appendChild(card);
    carouselCards.push(record);
  });

  const len = carouselLocations.length;
  carouselAngleStep = 360 / len;
    const cardWidth = carouselCards[0].element.offsetWidth;
  carouselRadius = (cardWidth / 2) / Math.tan(Math.PI / len);

  carouselCards.forEach((card, i) => {
    card.element.style.transform =
      `rotateY(${i * carouselAngleStep}deg) translateZ(${carouselRadius}px)`;
  });

  el.carouselPrev.onclick = () => step(-1);
  el.carouselNext.onclick = () => step(1);
  el.choosePathBtn.onclick = () => startLocation(carouselLocations[carouselIndex]);

  updateCarousel();
}

function step(direction) {
  const len = carouselLocations.length;
  carouselRotationSteps += direction;
  carouselIndex = ((carouselRotationSteps % len) + len) % len;
  updateCarousel();
}

function goToIndex(targetIdx) {
  const len = carouselLocations.length;
  const currentMod = ((carouselRotationSteps % len) + len) % len;
  let delta = targetIdx - currentMod;
  if (delta > len / 2) delta -= len;
  if (delta < -len / 2) delta += len;
  carouselRotationSteps += delta;
  carouselIndex = targetIdx;
  updateCarousel();
}

function updateCarousel() {
  el.carouselTrack.style.transform =
    `translateZ(${-carouselRadius}px) rotateY(${-carouselRotationSteps * carouselAngleStep}deg)`;

  carouselCards.forEach((card, i) => {
    let rel = (i - carouselRotationSteps) * carouselAngleStep;
    rel = ((rel + 180) % 360 + 360) % 360 - 180;
    const abs = Math.abs(rel);

    const opacity = abs < 1 ? 1 : Math.max(0.25, 1 - abs / 140);
    card.element.style.opacity = String(opacity);
    card.element.classList.toggle("is-center", abs < 1);
  });

  const current = carouselLocations[carouselIndex];
  el.carouselDescription.textContent = current.description || "";
}

// ---------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------

async function startLocation(loc) {
  try {
    el.locationSelect.classList.add("hidden");
    el.choosePathBtn.disabled = true;
    el.loading.classList.remove("hidden");

    carouselCards.forEach((card) => card.renderer && card.renderer.dispose());

    const res = await fetch(loc.dataFile);
    if (!res.ok) {
      throw new Error(`Could not load ${loc.dataFile} — status ${res.status}. Has this location's data file been added yet?`);
    }
    story = await res.json();

    try {
      const endingRes = await fetch(COMMON_ENDING_PATH);
      if (endingRes.ok) {
        const endingData = await endingRes.json();
        Object.assign(story.nodes, endingData.nodes);
      } else {
        console.warn(`Shared ending not found yet (${COMMON_ENDING_PATH}, status ${endingRes.status}) — continuing without it.`);
      }
    } catch (err) {
      console.warn("Could not load shared ending, continuing without it:", err);
    }

    currentId = story.start;
    await ensureImageLoaded(story.nodes[currentId].image);

    el.loading.classList.add("hidden");
    el.scene.classList.remove("hidden");

    if (!ditherStarted) {
      Dither.init(el.canvas);
      Dither.start();
      ditherStarted = true;
    }

    if (!inventorySetUp) {
      setupInventorySlot();
      inventorySetUp = true;
    }

    render();
  } catch (err) {
    showFatalError(err);
  }
}

let inventoryRenderer = null;

function setupInventorySlot() {
  if (!chosenItem) return;
  el.inventorySlot.classList.remove("hidden");

  const img = new Image();
  img.onload = () => {
    el.inventoryCanvas.classList.remove("hidden");
    el.inventoryFallback.classList.add("hidden");
    if (!inventoryRenderer) {
      inventoryRenderer = DitherFactory.create();
      inventoryRenderer.init(el.inventoryCanvas);
      inventoryRenderer.start();
    }
    inventoryRenderer.setImage(img);
  };
  img.onerror = () => {
    el.inventoryCanvas.classList.add("hidden");
    el.inventoryFallback.textContent = chosenItem.name;
    el.inventoryFallback.classList.remove("hidden");
  };
  img.src = chosenItem.icon;
}

function showFatalError(err) {
  console.error("Startup failed:", err);
  el.loading.classList.remove("hidden");
  el.loading.innerHTML = `
    <p class="loading-title" style="color:#c96a4a;">Something went wrong</p>
    <p class="loading-progress" style="max-width:70vw;text-align:center;">${err.message}</p>
    <p class="loading-progress">(Check the browser console for the full error.)</p>
  `;
}

// Loads one image and caches it, if not already cached/loading. Returns
// a promise that resolves once it's ready (or failed — either way the
// caller can proceed, a missing image just won't render).
function ensureImageLoaded(src) {
  if (!src) return Promise.resolve(null);
  if (imageCache[src]) return Promise.resolve(imageCache[src]);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => {
      imageCache[src] = img;
      resolve(img);
    };
    img.src = src;
  });
}

// Quietly starts loading images several steps ahead of the current node,
// while the player is still reading the current screen — covers someone
// clicking through quickly, not just the single very next image. At a
// choice point this follows both branches, so a few steps past a choice
// can mean several images loading at once; already-cached ones are
// skipped automatically, so revisiting the same ground costs nothing.
function prefetchUpcoming(node, depth = 10) {
  const queue = [{ node, remaining: depth }];
  const visited = new Set();

  while (queue.length) {
    const { node: current, remaining } = queue.shift();
    if (remaining <= 0) continue;

    const nextIds = [];
    if ((current.type === "linear" || current.type === "finish") && current.next) {
      nextIds.push(current.next);
    } else if (current.type === "choice") {
      current.choices.forEach((choice) => nextIds.push(choice.next));
    }

    nextIds.forEach((id) => {
      if (visited.has(id)) return;
      visited.add(id);
      const nextNode = story.nodes[id];
      if (!nextNode) return;
      if (nextNode.image) ensureImageLoaded(nextNode.image);
      queue.push({ node: nextNode, remaining: remaining - 1 });
    });
  }
}

function hideAllBoxes() {
  el.boxLinear.classList.add("hidden");
  el.boxLeft.classList.add("hidden");
  el.boxRight.classList.add("hidden");
  el.boxEnd.classList.add("hidden");
}

function goTo(nextId) {
  currentId = nextId;
  render();
}

async function render() {
  const node = story.nodes[currentId];
  if (!node) {
    console.error("Unknown node id:", currentId);
    hideAllBoxes();
    el.endText.textContent = `This path continues at "${currentId}", which hasn't been added yet.`;
    el.boxEnd.classList.remove("hidden");
    return;
  }

  if (node.image) {
    el.canvas.classList.remove("hidden");
    // Usually already cached by the previous screen's prefetch — this
    // only actually waits on a real load if someone clicks unusually fast.
    const image = await ensureImageLoaded(node.image);
    if (image) Dither.setImage(image);
  } else {
    // No image on this node — a genuinely blank screen (just the body's
    // black background showing through), used for the closing text screen.
    el.canvas.classList.add("hidden");
  }

  prefetchUpcoming(node);

  hideAllBoxes();

  if (node.type === "linear") {
    el.linearText.textContent = node.text;
    el.linearBtn.textContent = node.continueLabel || "Continue";
    el.boxLinear.classList.remove("hidden");
    el.boxLinear.classList.remove("textbox-center-screen");
    el.boxLinear.classList.remove("textbox-bare");
    el.linearBtn.classList.remove("choose-path-btn");
    el.linearBtn.classList.add("continue-btn");
    el.linearBtn.onclick = () => goTo(node.next);

  } else if (node.type === "choice") {
    const [left, right] = node.choices;

    el.leftText.textContent = left.text;
    el.leftBtn.textContent = left.label || "Continue this way";
    el.boxLeft.classList.remove("hidden");
    el.leftBtn.onclick = () => goTo(left.next);

    el.rightText.textContent = right.text;
    el.rightBtn.textContent = right.label || "Continue this way";
    el.boxRight.classList.remove("hidden");
    el.rightBtn.onclick = () => goTo(right.next);

  } else if (node.type === "end") {
    el.endText.textContent = node.text;
    el.boxEnd.classList.remove("hidden");

  } else if (node.type === "finish") {
    const isBlankScreen = !node.image;

    el.linearText.textContent = node.text;
    el.linearBtn.textContent = node.continueLabel || "Finish";
    el.boxLinear.classList.remove("hidden");
    el.boxLinear.classList.toggle("textbox-center-screen", isBlankScreen);
    el.boxLinear.classList.toggle("textbox-bare", isBlankScreen);
    el.linearBtn.classList.toggle("choose-path-btn", isBlankScreen);
    el.linearBtn.classList.toggle("continue-btn", !isBlankScreen);
    el.linearBtn.onclick = returnToTitle;

    if (isBlankScreen) {
      el.inventorySlot.classList.add("hidden");
    }
  }
}

function returnToTitle() {
  // Reset everything so a fresh playthrough starts clean — new item
  // choice, new location, new journey state.
  el.scene.classList.add("hidden");
  el.inventorySlot.classList.add("hidden");

  story = null;
  currentId = null;
  inventorySetUp = false;
  chosenItem = null;
  selectedItemIndex = null;

  el.screenTitle.classList.remove("hidden");
}

init();
