const PERMISSION_DEFINITIONS = [
  {
    key: 'view_all_posts',
    label: 'View All Posts',
    description: 'View the full public website article list when explicitly granted.'
  },
  {
    key: 'edit_post_text',
    label: 'Edit Post Text',
    description: 'Edit article title, summary, content, category, tags, and article details.'
  },
  {
    key: 'edit_post_image',
    label: 'Edit Post Image',
    description: 'Replace or update the featured image and image gallery for a post.'
  },
  {
    key: 'delete_own_pending_post',
    label: 'Delete Own Pending Post',
    description: 'Delete a pending post created by the employee.'
  },
  {
    key: 'edit_own_posts',
    label: 'Edit Own Posts',
    description: 'Edit posts created by the employee; submitted changes return to review.'
  },
  {
    key: 'approve_posts',
    label: 'Approve Posts',
    description: 'Approve submissions and publish them to the public website.'
  },
  {
    key: 'reject_posts',
    label: 'Reject Posts',
    description: 'Reject pending articles and return them for changes.'
  },
  {
    key: 'edit_any_post',
    label: 'Edit Any Post',
    description: 'Edit posts created by other employees or users when explicitly granted.'
  },
  {
    key: 'delete_any_post',
    label: 'Delete Any Post',
    description: 'Delete posts created by other employees or users when explicitly granted.'
  },
  {
    key: 'publish_approve_posts',
    label: 'Publish/Approve Posts',
    description: 'Move a post from pending to approved for publication.'
  },
  {
    key: 'manage_images',
    label: 'Manage Images',
    description: 'Upload, replace, or manage article images and gallery content.'
  }
];

const DEFAULT_EMPLOYEE_PERMISSION_KEYS = [
  'delete_own_pending_post'
];

function normalizePermissionKey(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized;
}

function buildPermissionMap(rows = []) {
  const permissions = {};

  for (const row of rows || []) {
    const key = normalizePermissionKey(
      row?.permission_key || row?.key || row?.name || row?.permissionKey
    );

    if (key) {
      permissions[key] = true;
    }
  }

  return permissions;
}

function hasEmployeePermission(user, permissionKey) {
  if (!user || !permissionKey) {
    return false;
  }

  const roleType = String(user.role_type || '').toLowerCase();

  if (roleType === 'admin' || roleType === 'chief_editor') {
    return true;
  }

  if (roleType !== 'employee') {
    return false;
  }

  const normalized = normalizePermissionKey(permissionKey);
  const permissions = user.permissions && typeof user.permissions === 'object'
    ? user.permissions
    : {};

  return Boolean(permissions[normalized]);
}

function canEmployeeManageOwnPendingPost(user, status, ownerId, currentUserId) {
  if (!user || String(user.role_type || '').toLowerCase() !== 'employee') {
    return false;
  }

  if (String(status || '').toLowerCase() !== 'pending') {
    return false;
  }

  if (Number(ownerId) !== Number(currentUserId)) {
    return false;
  }

  return hasEmployeePermission(user, 'edit_own_posts');
}

const ROLE_ADMIN = 'admin';
const ROLE_CHIEF_EDITOR = 'chief_editor';
const ROLE_EMPLOYEE = 'employee';

/* Roles that bypass per-employee permission grants entirely. */
function isPrivilegedRole(user) {
  const roleType = String(user?.role_type || '').toLowerCase();

  return roleType === ROLE_ADMIN || roleType === ROLE_CHIEF_EDITOR;
}

function isEmployeeRole(user) {
  return String(user?.role_type || '').toLowerCase() === ROLE_EMPLOYEE;
}

/* A post may declare its owner through a numeric id column or, for legacy
   rows written before `author_id` existed, through the author name/email
   text column. Both are checked so ownership survives data migrations. */
function isPostOwner(user, post) {
  if (!user || !post || !isEmployeeRole(user)) {
    return false;
  }

  const employeeId = Number(user.id);

  if (employeeId && [
    post.author_id,
    post.employee_id,
    post.created_by,
    post.createdBy,
  ].some((value) => value !== null && value !== undefined && Number(value) === employeeId)) {
    return true;
  }

  const authorName = String(post.Author || '').trim();

  if (!authorName) {
    return false;
  }

  return authorName === String(user.full_name || '').trim()
    || authorName === String(user.email || '').trim();
}

function normalizePostStatus(status) {
  return String(status || '').trim().toLowerCase();
}

/* Statuses an employee may still modify themselves. Everything else has been
   handed to the editorial desk (approved) or already left their hands. */
function isSelfManageableStatus(status) {
  return ['draft', 'pending'].includes(normalizePostStatus(status));
}

/* ---------------------------------------------------------
   Per-post capabilities.

   The backend uses this to authorise requests AND to publish an authoritative
   action map with every post it returns, so the frontend never has to guess
   which buttons an employee is allowed to see. Authorisation and UI hints are
   therefore derived from the exact same rules.
   --------------------------------------------------------- */
function buildPostCapabilities(user, post) {
  const none = {
    isOwner: false,
    canView: false,
    canEditText: false,
    canEditImage: false,
    canDelete: false,
    canApprove: false,
    canReject: false,
    canManageImages: false,
  };

  if (!user || !post) {
    return none;
  }

  if (isPrivilegedRole(user)) {
    return {
      isOwner: false,
      canView: true,
      canEditText: true,
      canEditImage: true,
      canDelete: true,
      canApprove: true,
      canReject: true,
      canManageImages: true,
    };
  }

  if (!isEmployeeRole(user)) {
    return none;
  }

  const isOwner = isPostOwner(user, post);
  const status = normalizePostStatus(post.status);
  const canManageImages = hasEmployeePermission(user, 'manage_images');
  const canEditAny = hasEmployeePermission(user, 'edit_any_post');

    /* Employees may revise their own posts; submitted changes are returned to
      review by the update route. Other authors' posts still need a broad grant. */
    const ownsEditablePost = isOwner;

  /* "Edit Post Text" / "Edit Post Image" describe *what* may be edited, so they
     also apply to other people's posts. "Edit Any Post" is the stronger grant
     that additionally lifts the draft/pending and ownership restrictions. */
  const canEditText = canEditAny
    || hasEmployeePermission(user, 'edit_post_text')
    || (ownsEditablePost && hasEmployeePermission(user, 'edit_own_posts'));

  const canEditImage = canEditAny
    || hasEmployeePermission(user, 'edit_post_image')
    || canManageImages
    || (ownsEditablePost && hasEmployeePermission(user, 'edit_own_posts'));

  /* Deletion rules, in order of authority:
       - nothing that has been published is ever removable by an employee;
       - someone else's post needs the broad "Delete Any Post" grant;
       - a submission of your own (pending, or sent back as rejected) needs
         "Delete Own Pending Post";
       - a private draft is unsubmitted and stays removable by its author, which
         preserves the existing employee drafting workflow.
     Note that viewing a post never contributes to any of these checks. */
  const canDelete = (() => {
    if (status === 'approved') {
      return false;
    }

    if (!isOwner) {
      return hasEmployeePermission(user, 'delete_any_post');
    }

    if (status === 'draft') {
      return true;
    }

    return hasEmployeePermission(user, 'delete_own_pending_post')
      || hasEmployeePermission(user, 'delete_any_post');
  })();

  const canView = isOwner
    || hasEmployeePermission(user, 'view_all_posts')
    || hasEmployeePermission(user, 'edit_any_post')
    || hasEmployeePermission(user, 'delete_any_post')
    || hasEmployeePermission(user, 'edit_post_text')
    || hasEmployeePermission(user, 'edit_post_image')
    || hasEmployeePermission(user, 'manage_images')
    || hasEmployeePermission(user, 'approve_posts')
    || hasEmployeePermission(user, 'reject_posts')
    || hasEmployeePermission(user, 'publish_approve_posts');

  return {
    isOwner,
    canView,
    canEditText,
    canEditImage,
    canDelete,
    canApprove: hasEmployeePermission(user, 'approve_posts')
      || hasEmployeePermission(user, 'publish_approve_posts'),
    canReject: hasEmployeePermission(user, 'reject_posts'),
    canManageImages,
  };
}

/* Attach the capability map to each post so clients can render exactly the
   actions the backend will actually allow. */
function attachPostCapabilities(user, posts) {
  const list = Array.isArray(posts) ? posts : [];

  return list.map((post) => {
    if (!post || typeof post !== 'object') {
      return post;
    }

    return {
      ...post,
      permissions: buildPostCapabilities(user, post),
    };
  });
}

module.exports = {
  PERMISSION_DEFINITIONS,
  DEFAULT_EMPLOYEE_PERMISSION_KEYS,
  normalizePermissionKey,
  buildPermissionMap,
  hasEmployeePermission,
  canEmployeeManageOwnPendingPost,
  isPrivilegedRole,
  isEmployeeRole,
  isPostOwner,
  isSelfManageableStatus,
  normalizePostStatus,
  buildPostCapabilities,
  attachPostCapabilities,
};
