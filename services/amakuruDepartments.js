const AMAKURU_DEPARTMENTS = Object.freeze([
  'Ubuzima',
  'Iyobokamana',
  'Poritike',
  'Ikoranabuhanga',
  'Mu Karere',
  'Mu Mahanga',
  'Ubuvumbuzi',
]);

function isAmakuruCategory(category) {
  return String(category || '').trim().toLowerCase() === 'amakuru';
}

function normalizeAmakuruDepartment(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;

  return AMAKURU_DEPARTMENTS.find(
    (department) => department.toLowerCase() === normalized
  ) || null;
}

function requiresAmakuruDepartmentOnUpdate({ category, updatedStatus }) {
  if (!isAmakuruCategory(category) || String(updatedStatus || '').toLowerCase() === 'draft') {
    return false;
  }

  return true;
}

module.exports = {
  AMAKURU_DEPARTMENTS,
  isAmakuruCategory,
  normalizeAmakuruDepartment,
  requiresAmakuruDepartmentOnUpdate,
};