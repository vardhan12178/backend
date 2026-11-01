import { listAlerts, createAlert, removeAlert, AlertError } from "../services/alerts.service.js";

const fail = (res, err, where) => {
  if (err instanceof AlertError) return res.status(err.status).json({ message: err.message });
  console.error(`alerts ${where}:`, err);
  return res.status(500).json({ message: "Server error" });
};

export const list = async (req, res) => {
  try { res.json({ alerts: await listAlerts(req.user.userId) }); } catch (err) { fail(res, err, "list"); }
};

export const create = async (req, res) => {
  try { res.status(201).json(await createAlert(req.user.userId, req.body)); } catch (err) { fail(res, err, "create"); }
};

export const remove = async (req, res) => {
  try { await removeAlert(req.user.userId, req.params.id); res.json({ ok: true }); } catch (err) { fail(res, err, "remove"); }
};
