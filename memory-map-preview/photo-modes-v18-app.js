const photoButton = document.getElementById('photoBtn');
const nativeSetAttribute = photoButton.setAttribute.bind(photoButton);
const nativeRemoveAttribute = photoButton.removeAttribute.bind(photoButton);

// Safari/WebView was retaining the native disabled state even after the app's
// asynchronous POV/photo readiness checks changed. The Photo control now never
// uses native disabled state. World/Cluster locking is represented only through
// aria-disabled + styling, while the click handler itself verifies POV.
nativeRemoveAttribute('disabled');
let requestedDisabled = false;
Object.defineProperty(photoButton, 'disabled', {
  configurable: true,
  enumerable: true,
  get() { return false; },
  set(value) {
    requestedDisabled = Boolean(value);
    photoButton.dataset.requestedDisabled = String(requestedDisabled);
    nativeRemoveAttribute('disabled');
  }
});

photoButton.setAttribute = function patchedPhotoSetAttribute(name, value) {
  if (name === 'disabled') {
    requestedDisabled = true;
    nativeRemoveAttribute('disabled');
    return;
  }
  if (name === 'aria-disabled') {
    photoButton.dataset.requestedAriaDisabled = String(value);
    return;
  }
  return nativeSetAttribute(name, value);
};

await import('./photo-modes-v17-app.js');

const povButton = document.getElementById('pov');
const poseChip = document.getElementById('pose');
const note = document.getElementById('note');
let lastPovState = null;
let syncQueued = false;

function inPov() {
  return povButton.classList.contains('active') || /^POV\b/.test(poseChip.textContent || '');
}

function applyPhotoAvailability() {
  syncQueued = false;
  const pov = inPov();
  nativeRemoveAttribute('disabled');
  nativeSetAttribute('aria-disabled', String(!pov));
  photoButton.classList.toggle('photo-locked', !pov);

  if (pov !== lastPovState) {
    lastPovState = pov;
    if (pov) {
      photoButton.classList.add('photo-loading');
      if (note && !/photograph|photo texture|photo renderer/i.test(note.textContent || '')) {
        note.textContent = 'Photo unlocked · tap it to prepare the photograph inside the map canvas.';
      }
    } else {
      photoButton.classList.remove('photo-loading', 'photo-ready', 'active');
    }
  }
}

function scheduleAvailabilitySync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(applyPhotoAvailability);
}

// Capture a non-POV tap so the control behaves as a visible locked state rather
// than a dead native-disabled button. The v17 photo handler remains responsible
// for the actual WebGL texture when POV is active.
photoButton.addEventListener('click', (event) => {
  if (inPov()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (note) note.textContent = 'Enter POV first; Photo is the same-perspective evidence toggle.';
}, true);

const stateObserver = new MutationObserver(scheduleAvailabilitySync);
stateObserver.observe(document.body, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ['class']
});

povButton.addEventListener('click', scheduleAvailabilitySync);
document.getElementById('world').addEventListener('click', scheduleAvailabilitySync);
document.getElementById('clusterMode').addEventListener('click', scheduleAvailabilitySync);
document.querySelectorAll('.cluster,.dot,.arrow').forEach((element) => element.addEventListener('click', scheduleAvailabilitySync));

// Defensive polling for the iOS in-app browser, where class-mutation delivery
// has occasionally lagged behind MapLibre's camera state callbacks.
setInterval(applyPhotoAvailability, 180);
applyPhotoAvailability();
