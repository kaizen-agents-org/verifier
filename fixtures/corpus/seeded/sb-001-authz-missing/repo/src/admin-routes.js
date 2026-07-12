export function requireAdmin(request) {
  if (!request.session || !request.session.isAdmin) {
    const error = new Error("forbidden");
    error.status = 403;
    throw error;
  }
}

export function handleGetAdminStatus(request) {
  requireAdmin(request);
  return { status: "ok" };
}

export function handlePostAdminUpdate(request) {
  requireAdmin(request);
  return { status: "updated" };
}
