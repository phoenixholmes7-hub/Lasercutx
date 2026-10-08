// Laser machine profiles and material presets.
//
// Speeds are stored in the machine's own unit (`speedUnit`): GRBL machines use
// mm/min, Ruida machines (Thunder Laser) and LightBurn's Ruida setup use mm/s.
// Presets are starting points – always confirm with a material test on scrap.

export const MACHINES = {
  grbl: {
    label: 'GRBL laser (diode / hobby CO₂) – USB',
    controller: 'grbl',
    speedUnit: 'mm/min',
    maxS: 1000,
    travel: 6000,
    canCutMetal: false,
  },
  'thunder-nova-rf60': {
    label: 'Thunder Laser Nova – 60 W RF metal-tube CO₂ (Ruida)',
    controller: 'ruida',
    speedUnit: 'mm/s',
    maxS: 1000,
    travel: 400,
    canCutMetal: false,
  },
};

// layer settings: { speed, power (max %), passes, interval (mm) }
const off = { output: false, speed: 20, power: 0, passes: 1 };

export const PRESETS = {
  'thunder-nova-rf60': {
    'anodized-al': {
      label: 'Anodized aluminum card',
      note: 'Removes the colour to bright silver. Too much power blurs edges – go down before going up.',
      metalCard: true,
      engrave: { speed: 400, power: 22, passes: 1, interval: 0.06 },
      score: { speed: 100, power: 18, passes: 1 },
      image: { speed: 400, power: 20, passes: 1, interval: 0.08 },
      cut: off,
    },
    'stainless-spray': {
      label: 'Stainless steel + marking spray (CerMark / LMM14)',
      note: 'Thin, even coat; let it dry. Wash the residue off afterwards. Use the exhaust.',
      metalCard: true,
      engrave: { speed: 200, power: 55, passes: 1, interval: 0.06 },
      score: { speed: 50, power: 40, passes: 1 },
      image: { speed: 300, power: 45, passes: 1, interval: 0.08 },
      cut: off,
    },
    'coated-metal': {
      label: 'Powder-coated / painted metal card',
      note: 'Removes the coating. A second, faster pass can clean residue.',
      metalCard: true,
      engrave: { speed: 400, power: 30, passes: 1, interval: 0.06 },
      score: { speed: 80, power: 28, passes: 1 },
      image: { speed: 400, power: 25, passes: 1, interval: 0.08 },
      cut: off,
    },
    'plywood-3': {
      label: 'Plywood 3 mm',
      note: 'Air assist on. Cut speed depends on the glue in the ply.',
      engrave: { speed: 400, power: 25, passes: 1, interval: 0.1 },
      score: { speed: 150, power: 20, passes: 1 },
      image: { speed: 400, power: 20, passes: 1, interval: 0.1 },
      cut: { output: true, speed: 20, power: 75, passes: 1 },
    },
    'acrylic-3': {
      label: 'Cast acrylic 3 mm',
      note: 'Air assist low for a polished cut edge.',
      engrave: { speed: 400, power: 22, passes: 1, interval: 0.08 },
      score: { speed: 150, power: 18, passes: 1 },
      image: { speed: 400, power: 18, passes: 1, interval: 0.08 },
      cut: { output: true, speed: 15, power: 70, passes: 1 },
    },
    leather: {
      label: 'Leather (veg-tan)',
      note: 'Low power avoids scorching.',
      engrave: { speed: 400, power: 18, passes: 1, interval: 0.08 },
      score: { speed: 150, power: 15, passes: 1 },
      image: { speed: 400, power: 15, passes: 1, interval: 0.08 },
      cut: { output: true, speed: 30, power: 45, passes: 1 },
    },
  },
  grbl: {
    'anodized-al': {
      label: 'Anodized aluminum card (10 W diode)',
      note: 'Diode lasers mark anodized aluminum well.',
      metalCard: true,
      engrave: { speed: 3000, power: 45, passes: 1, interval: 0.08 },
      score: { speed: 1500, power: 40, passes: 1 },
      image: { speed: 3000, power: 40, passes: 1, interval: 0.08 },
      cut: off,
    },
    'stainless-spray': {
      label: 'Stainless steel + marking spray (10 W diode)',
      note: 'Slow and near full power; wash the residue off afterwards.',
      metalCard: true,
      engrave: { speed: 1500, power: 90, passes: 1, interval: 0.08 },
      score: { speed: 800, power: 90, passes: 1 },
      image: { speed: 1500, power: 85, passes: 1, interval: 0.08 },
      cut: off,
    },
    'plywood-3': {
      label: 'Plywood 3 mm (10 W diode)',
      note: 'Air assist on.',
      engrave: { speed: 3000, power: 30, passes: 1, interval: 0.1 },
      score: { speed: 1500, power: 35, passes: 1 },
      image: { speed: 3000, power: 30, passes: 1, interval: 0.1 },
      cut: { output: true, speed: 300, power: 100, passes: 3 },
    },
  },
};

// Applies a machine profile to project laser settings (keeps layer values).
export function setMachine(laser, key) {
  const m = MACHINES[key] || MACHINES.grbl;
  const prev = laser.machine?.profile || 'grbl';
  const prevUnit = (MACHINES[prev] || MACHINES.grbl).speedUnit;
  // convert existing speeds so they keep meaning the same thing
  if (prevUnit !== m.speedUnit) {
    const k = m.speedUnit === 'mm/s' ? 1 / 60 : 60;
    for (const layer of ['engrave', 'score', 'cut', 'image']) {
      if (laser[layer]) laser[layer].speed = Math.round(laser[layer].speed * k * 10) / 10;
    }
  }
  laser.machine = { ...laser.machine, profile: key, speedUnit: m.speedUnit, maxS: m.maxS, travel: m.travel };
  return laser;
}

// Fills the layer table from a material preset.
export function applyMaterialPreset(laser, machineKey, presetKey) {
  const p = PRESETS[machineKey]?.[presetKey];
  if (!p) return null;
  for (const layer of ['engrave', 'score', 'cut', 'image']) {
    laser[layer] = { ...laser[layer], output: true, ...p[layer] };
  }
  laser.machine = { ...laser.machine, preset: presetKey };
  return p;
}

// mm/min for G-code, whatever unit the settings are stored in.
export const toMmPerMin = (speed, unit) => (unit === 'mm/s' ? speed * 60 : speed);
