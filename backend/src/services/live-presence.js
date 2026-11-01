const hostDisconnectTimers = new Map();

// A host who dropped recently is still live while the reconnect grace timer runs.
function isHostConnectedToLive(io, sessionId, hostId) {
  if (hostDisconnectTimers.has(String(sessionId))) return true;
  const room = io && io.sockets.adapter.rooms.get(String(sessionId));
  if (!room) return false;

  for (const socketId of room) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket && socket.user && socket.user.id === hostId) {
      return true;
    }
  }

  return false;
}

module.exports = { isHostConnectedToLive, hostDisconnectTimers };
