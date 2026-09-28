const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_EMPLOYEE_PERMISSION_KEYS,
  PERMISSION_DEFINITIONS,
  normalizePermissionKey,
  buildPermissionMap,
  hasEmployeePermission,
  canEmployeeManageOwnPendingPost,
  isPostOwner,
  buildPostCapabilities,
} = require('./permissionRules');

test('normalizes permission keys cleanly', () => {
  assert.equal(normalizePermissionKey(' Edit Post Text '), 'edit_post_text');
  assert.equal(normalizePermissionKey('approve_posts'), 'approve_posts');
});

test('buildPermissionMap reads explicit employee permissions', () => {
  const map = buildPermissionMap([
    { permission_key: 'edit_post_text' },
    { permission_key: 'delete_own_pending_post' },
  ]);

  assert.equal(map.edit_post_text, true);
  assert.equal(map.delete_own_pending_post, true);
  assert.equal(map.approve_posts, undefined);
});

test('employee permission checks follow explicit grants', () => {
  const user = { role_type: 'employee', permissions: { edit_post_text: true, delete_own_pending_post: true } };

  assert.equal(hasEmployeePermission(user, 'edit_post_text'), true);
  assert.equal(hasEmployeePermission(user, 'approve_posts'), false);
  assert.equal(hasEmployeePermission({ role_type: 'admin' }, 'approve_posts'), true);
});

test('own-post editing is opt-in and excluded from employee defaults', () => {
  assert.equal(DEFAULT_EMPLOYEE_PERMISSION_KEYS.includes('edit_own_posts'), false);
  assert.equal(
    PERMISSION_DEFINITIONS.some((permission) => permission.key === 'edit_own_posts'),
    true
  );

  const employee = { id: 7, role_type: 'employee', permissions: {} };
  const ownPost = { id: 1, author_id: 7, status: 'pending' };
  assert.equal(buildPostCapabilities(employee, ownPost).canEditText, false);

  const legacyEmployee = {
    id: 7,
    role_type: 'employee',
    permissions: { edit_own_pending_post: true },
  };
  assert.equal(buildPostCapabilities(legacyEmployee, ownPost).canEditText, false);

  employee.permissions.edit_own_posts = true;
  assert.equal(buildPostCapabilities(employee, ownPost).canEditText, true);
});

test('employees only get the full post list when view_all_posts is explicitly granted', () => {
  const allowedUser = { role_type: 'employee', permissions: { view_all_posts: true } };
  const restrictedUser = { role_type: 'employee', permissions: {} };

  assert.equal(hasEmployeePermission(allowedUser, 'view_all_posts'), true);
  assert.equal(hasEmployeePermission(restrictedUser, 'view_all_posts'), false);
});

test('employees can manage their own pending posts when explicitly granted', () => {
  const user = { role_type: 'employee', permissions: { edit_own_posts: true, delete_own_pending_post: true } };

  assert.equal(canEmployeeManageOwnPendingPost(user, 'pending', 42, 42), true);
  assert.equal(canEmployeeManageOwnPendingPost(user, 'pending', 42, 99), false);
  assert.equal(canEmployeeManageOwnPendingPost(user, 'approved', 42, 42), false);
});

/* ---------------------------------------------------------
   Ownership
   --------------------------------------------------------- */

test('ownership is recognised through the id column and the legacy name column', () => {
  const user = { id: 7, role_type: 'employee', full_name: 'Alice', email: 'alice@rubavu.rw' };

  assert.equal(isPostOwner(user, { author_id: 7, status: 'pending' }), true);
  assert.equal(isPostOwner(user, { author_id: '7', status: 'pending' }), true);
  assert.equal(isPostOwner(user, { Author: 'Alice', status: 'pending' }), true);
  assert.equal(isPostOwner(user, { Author: 'alice@rubavu.rw', status: 'pending' }), true);
  assert.equal(isPostOwner(user, { Author: 'Bob', status: 'pending' }), false);
  assert.equal(isPostOwner(user, { author_id: null, status: 'pending' }), false);
});

/* ---------------------------------------------------------
   Per-post capabilities (feature 1 + 3)
   --------------------------------------------------------- */

test('view_all_posts alone only unlocks viewing, never editing or deleting', () => {
  const user = { id: 7, role_type: 'employee', permissions: { view_all_posts: true } };
  const otherPost = { id: 100, author_id: 9, status: 'pending' };

  const caps = buildPostCapabilities(user, otherPost);

  assert.equal(caps.canView, true, 'should see every post');
  assert.equal(caps.canEditText, false, 'viewing must not imply editing');
  assert.equal(caps.canEditImage, false, 'viewing must not imply image editing');
  assert.equal(caps.canDelete, false, 'viewing must not imply deleting');
  assert.equal(caps.canApprove, false, 'viewing must not imply approving');
  assert.equal(caps.canReject, false, 'viewing must not imply rejecting');
});

test('an employee without view_all_posts cannot view another employee post', () => {
  const user = { id: 7, role_type: 'employee', permissions: {} };
  const otherPost = { id: 100, author_id: 9, status: 'pending' };

  const caps = buildPostCapabilities(user, otherPost);

  assert.equal(caps.canView, false);
  assert.equal(caps.isOwner, false);
});

test('employees may edit and delete their own pending post with explicit grants', () => {
  const user = {
    id: 7,
    role_type: 'employee',
    full_name: 'Alice',
    permissions: { edit_own_posts: true, delete_own_pending_post: true },
  };
  const ownPending = { id: 1, author_id: 7, status: 'pending' };

  const caps = buildPostCapabilities(user, ownPending);

  assert.equal(caps.isOwner, true);
  assert.equal(caps.canView, true);
  assert.equal(caps.canEditText, true);
  assert.equal(caps.canDelete, true);
});

test('an employee cannot edit or delete another employee post without a grant', () => {
  const user = { id: 7, role_type: 'employee', permissions: {} };
  const otherPending = { id: 2, author_id: 9, status: 'pending' };

  const caps = buildPostCapabilities(user, otherPending);

  assert.equal(caps.canEditText, false);
  assert.equal(caps.canEditImage, false);
  assert.equal(caps.canDelete, false);
});

test('edit_any_post and delete_any_post unlock other people posts', () => {
  const user = { id: 7, role_type: 'employee', permissions: { edit_any_post: true, delete_any_post: true } };
  const otherPending = { id: 3, author_id: 9, status: 'pending' };

  const caps = buildPostCapabilities(user, otherPending);

  assert.equal(caps.canView, true, 'edit_any_post should also allow viewing the post');
  assert.equal(caps.canEditText, true);
  assert.equal(caps.canDelete, true);
});

test('explicit edit grants allow employees to edit existing approved posts', () => {
  const user = {
    id: 7,
    role_type: 'employee',
    permissions: { edit_post_text: true, edit_post_image: true },
  };
  const ownApproved = { id: 4, author_id: 7, status: 'approved' };

  const caps = buildPostCapabilities(user, ownApproved);

  assert.equal(caps.canEditText, true);
  assert.equal(caps.canEditImage, true);
  assert.equal(caps.canDelete, false, 'edit permission must not grant delete access');
});

test('published posts remain protected from employee deletion', () => {
  const user = {
    id: 7,
    role_type: 'employee',
    full_name: 'Alice',
    permissions: {
      edit_own_posts: true,
      delete_own_pending_post: true,
      edit_any_post: true,
      delete_any_post: true,
      edit_post_text: true,
    },
  };

  const ownApproved = buildPostCapabilities(user, { id: 4, author_id: 7, status: 'approved' });
  assert.equal(ownApproved.canEditText, true, 'explicit edit permission allows editing');
  assert.equal(ownApproved.canDelete, false, 'own approved post must not be deletable');

  const otherApproved = buildPostCapabilities(user, { id: 5, author_id: 9, status: 'approved' });
  assert.equal(otherApproved.canDelete, false, 'other approved post must not be deletable');
});

test('employees can edit their own posts across statuses with the own-post grant', () => {
  const user = {
    id: 7,
    role_type: 'employee',
    full_name: 'Alice',
    permissions: { edit_own_posts: true, delete_own_pending_post: true },
  };

  const ownDraft = buildPostCapabilities(user, { id: 6, author_id: 7, status: 'draft' });
  assert.equal(ownDraft.canEditText, true, 'own drafts stay editable');
  assert.equal(ownDraft.canDelete, true, 'own unsubmitted drafts stay deletable');

  const ownRejected = buildPostCapabilities(user, { id: 7, author_id: 7, status: 'rejected' });
  assert.equal(ownRejected.canEditText, true, 'own rejected posts can be revised');
  assert.equal(ownRejected.canDelete, true, 'own rejected post is still a submission');

  const ownApproved = buildPostCapabilities(user, { id: 8, author_id: 7, status: 'approved' });
  assert.equal(ownApproved.canEditText, true, 'own published posts can be revised');
  assert.equal(ownApproved.canDelete, false, 'published posts remain protected from deletion');

  const noGrants = buildPostCapabilities(
    { id: 7, role_type: 'employee', full_name: 'Alice', permissions: {} },
    { id: 7, author_id: 7, status: 'pending' }
  );
  assert.equal(noGrants.canDelete, false, 'Delete Own Pending Post is required for pending');
  assert.equal(noGrants.canEditText, false, 'Edit Own Pending Post is required for pending');
});

test('approve, reject and image grants stay independent from one another', () => {
  const approveOnly = { id: 7, role_type: 'employee', permissions: { approve_posts: true } };
  const caps = buildPostCapabilities(approveOnly, { id: 8, author_id: 9, status: 'pending' });

  assert.equal(caps.canApprove, true);
  assert.equal(caps.canReject, false, 'Approve must not imply Reject');
  assert.equal(caps.canManageImages, false, 'Approve must not imply Manage Images');

  const publishOnly = { id: 7, role_type: 'employee', permissions: { publish_approve_posts: true } };
  assert.equal(buildPostCapabilities(publishOnly, { id: 9, status: 'pending' }).canApprove, true);
});

test('admin and chief editor bypass every per-employee grant', () => {
  const caps = buildPostCapabilities({ id: 1, role_type: 'admin' }, { id: 10, status: 'approved' });

  assert.equal(caps.canView, true);
  assert.equal(caps.canEditText, true);
  assert.equal(caps.canEditImage, true);
  assert.equal(caps.canDelete, true);
  assert.equal(caps.canApprove, true);
  assert.equal(caps.canReject, true);
});
