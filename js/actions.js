// Sorting actions for the sheet's Actions tab: basic actions, skill actions (by skill, with the bonus to roll)
// and special actions from class, feats, archetypes, ancestry and items.
// Skill actions follow the Player Core skill chapter; the rules data doesn't say which skill an action uses.

/** slug → skills it's used with; trained: needs at least trained proficiency (Player Core "Trained" actions). */
export const SKILL_ACTIONS = {
  // Acrobatics
  balance: { skills: ['acrobatics'] }, 'tumble-through': { skills: ['acrobatics'] },
  'maneuver-in-flight': { skills: ['acrobatics'], trained: true }, squeeze: { skills: ['acrobatics'], trained: true },
  'plummeting-roll': { skills: ['acrobatics'] },
  // Arcana / Nature / Occultism / Religion (magic and knowledge)
  'recall-knowledge': { skills: ['arcana', 'crafting', 'medicine', 'nature', 'occultism', 'religion', 'society', 'lore'] },
  'borrow-an-arcane-spell': { skills: ['arcana'], trained: true },
  'decipher-writing': { skills: ['arcana', 'occultism', 'religion', 'society'], trained: true },
  'identify-magic': { skills: ['arcana', 'nature', 'occultism', 'religion'], trained: true },
  'learn-a-spell': { skills: ['arcana', 'nature', 'occultism', 'religion'], trained: true },
  'psychometric-assessment': { skills: ['occultism'], trained: true },
  // Athletics
  climb: { skills: ['athletics'] }, 'force-open': { skills: ['athletics'] }, grapple: { skills: ['athletics'] },
  'high-jump': { skills: ['athletics'] }, 'long-jump': { skills: ['athletics'] }, reposition: { skills: ['athletics'] },
  shove: { skills: ['athletics'] }, swim: { skills: ['athletics'] }, trip: { skills: ['athletics'] },
  disarm: { skills: ['athletics'], trained: true },
  // Crafting
  repair: { skills: ['crafting'] }, craft: { skills: ['crafting'], trained: true }, 'identify-alchemy': { skills: ['crafting'], trained: true },
  deconstruct: { skills: ['crafting'] },
  'earn-income': { skills: ['crafting', 'performance', 'lore'], trained: true },
  // Deception
  'create-a-diversion': { skills: ['deception'] }, impersonate: { skills: ['deception'] }, lie: { skills: ['deception'] },
  feint: { skills: ['deception'], trained: true },
  // Diplomacy
  'gather-information': { skills: ['diplomacy'] }, 'make-an-impression': { skills: ['diplomacy'] }, request: { skills: ['diplomacy'] },
  // Intimidation
  coerce: { skills: ['intimidation'] }, demoralize: { skills: ['intimidation'] },
  // Medicine
  'administer-first-aid': { skills: ['medicine'] }, 'treat-disease': { skills: ['medicine'], trained: true },
  'treat-poison': { skills: ['medicine'], trained: true }, 'treat-wounds': { skills: ['medicine'], trained: true },
  // Nature
  'command-an-animal': { skills: ['nature'] },
  // Performance
  perform: { skills: ['performance'] },
  // Society
  'create-forgery': { skills: ['society'], trained: true },
  subsist: { skills: ['society', 'survival'] },
  // Stealth
  'conceal-an-object': { skills: ['stealth'] }, hide: { skills: ['stealth'] }, sneak: { skills: ['stealth'] },
  'avoid-notice': { skills: ['stealth'] },
  // Survival
  'sense-direction': { skills: ['survival'] }, 'cover-tracks': { skills: ['survival'], trained: true },
  track: { skills: ['survival'], trained: true }, 'fortify-camp': { skills: ['survival'] },
  // Thievery
  'palm-an-object': { skills: ['thievery'] }, steal: { skills: ['thievery'] },
  'disable-a-device': { skills: ['thievery'], trained: true }, 'pick-a-lock': { skills: ['thievery'], trained: true },
};

/** The Player Core "Basic actions" list; the other basic-folder actions are specialty basic actions. */
export const CORE_BASIC = ['aid', 'crawl', 'delay', 'drop-prone', 'escape', 'interact', 'leap', 'ready', 'release', 'seek', 'sense-motive', 'stand', 'step', 'stride', 'strike', 'take-cover'];
/** Basic actions that only make sense with a matching speed. */
export const NEEDS_SPEED = { burrow: 'burrow', fly: 'fly', 'arrest-a-fall': 'fly' };
/** Basic actions rolled with Perception or a pair of skills. */
export const BASIC_ROLLS = { seek: ['perception'], 'sense-motive': ['perception'], escape: ['acrobatics', 'athletics'] };

/** encounter / exploration / downtime, from the traits. */
export function modeOf(rec) {
  const t = rec.traits || [];
  if (t.includes('downtime') || rec.grp === 'downtime') return 'downtime';
  if (t.includes('exploration') || rec.grp === 'exploration') return 'exploration';
  return 'encounter';
}

/** Cost bucket for the filter chips. */
export function costOf(rec) {
  if (rec.action === 'reaction') return 'reaction';
  if (rec.action === 'free') return 'free';
  if (rec.action === 'action' && rec.actions) return String(Math.min(3, rec.actions));
  return 'activity';
}

/** Where a special action came from, for its heading. */
export function originOf(x) {
  const r = x.rec;
  const slotType = x.slot?.type;
  if (slotType === 'archetype' || r.arch || r.grp === 'archetype') return 'Archetype';
  if (slotType === 'ancestry' || ['ancestry', 'heritage'].includes(r.grp) || r._pack === 'ancestryfeatures' || r._pack === 'heritages') return 'Ancestry & heritage';
  if (slotType === 'skill') return 'Skill feats';
  if (slotType === 'general') return 'General feats';
  if (r.grp === 'background' || r._pack === 'backgrounds') return 'Background';
  if (r._pack === 'equipment' || r._pack === 'item-actions' || r.grp === 'equipment') return 'Items';
  if (slotType === 'class' || r._pack === 'classfeatures' || r.grp === 'class') return 'Class';
  if (r._pack === 'feats') return r.cat === 'skill' ? 'Skill feats' : r.cat === 'general' ? 'General feats' : r.cat === 'ancestry' ? 'Ancestry & heritage' : r.cat === 'class' ? 'Class' : 'Other';
  return 'Other';
}
export const ORIGIN_ORDER = ['Class', 'Archetype', 'Ancestry & heritage', 'Skill feats', 'General feats', 'Background', 'Items', 'Other'];
