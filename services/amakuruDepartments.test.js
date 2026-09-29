const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AMAKURU_DEPARTMENTS,
  isAmakuruCategory,
  normalizeAmakuruDepartment,
  requiresAmakuruDepartmentOnUpdate,
} = require('./amakuruDepartments');

test('recognizes the Amakuru main category without matching other categories', () => {
  assert.equal(isAmakuruCategory(' Amakuru '), true);
  assert.equal(isAmakuruCategory('Ubukungu'), false);
});

test('normalizes only the supported Amakuru departments', () => {
  for (const department of AMAKURU_DEPARTMENTS) {
    assert.equal(normalizeAmakuruDepartment(department.toLowerCase()), department);
  }

  assert.equal(normalizeAmakuruDepartment(''), null);
  assert.equal(normalizeAmakuruDepartment('Unlisted department'), null);
});

test('requires departments on non-draft Amakuru updates, including legacy posts', () => {
  assert.equal(requiresAmakuruDepartmentOnUpdate({
    category: 'Amakuru',
    updatedStatus: 'pending',
  }), true);

  assert.equal(requiresAmakuruDepartmentOnUpdate({
    category: 'Amakuru',
    updatedStatus: 'pending',
  }), true);

  assert.equal(requiresAmakuruDepartmentOnUpdate({
    category: 'Amakuru',
    updatedStatus: 'draft',
  }), false);

  assert.equal(requiresAmakuruDepartmentOnUpdate({
    category: 'Ubukungu',
    existingCategory: 'Ubukungu',
    existingStatus: 'draft',
    updatedStatus: 'pending',
  }), false);
});