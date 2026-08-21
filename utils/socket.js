import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { allowOrigin } from '../middleware/security.js';

let io;

const getTokenFromCookie = (cookieHeader = '') => {
    const rawToken = String(cookieHeader)
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('jwt_token='))
        ?.slice('jwt_token='.length);

    return rawToken ? decodeURIComponent(rawToken) : '';
};

export const initSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: {
            origin: (origin, callback) => {
                if (allowOrigin(origin)) {
                    callback(null, true);
                } else {
                    callback(null, false);
                }
            },
            methods: ["GET", "POST"],
            credentials: true
        }
    });

    // Authenticate socket connections via JWT
    io.use((socket, next) => {
        const token =
            socket.handshake.auth?.token ||
            getTokenFromCookie(socket.handshake.headers?.cookie);

        if (!token) {
            socket.user = null; // unauthenticated — allowed to connect but restricted
            return next();
        }

        try {
            const payload = jwt.verify(token, process.env.JWT_SECRET);
            socket.user = payload;
        } catch {
            socket.user = null;
        }
        next();
    });

    io.on('connection', (socket) => {
        const roles = Array.isArray(socket.user?.roles) ? socket.user.roles : [];
        const isSupportAgent = socket.user?.adminRole === 'super_admin' || socket.user?.adminRole === 'customer_support';

        if (socket.user?.userId) {
            socket.join(`user_${socket.user.userId}`);
        }

        if (roles.includes('admin')) {
            socket.join('admin_notifications');
        }

        if (isSupportAgent) {
            socket.join('support_agents');
        }

        // Admin joins admin room — must be authenticated admin
        socket.on('join_admin', () => {
            if (roles.includes('admin')) {
                socket.join('admin_notifications');
            }
        });

        // User joins their personal room — must match their own userId
        socket.on('join_user', (userId) => {
            if (userId && socket.user?.userId && String(socket.user.userId) === String(userId)) {
                socket.join(`user_${userId}`);
            }
        });

        // Support chat typing indicator — ephemeral, never persisted. A
        // customer's keystroke relays to every support agent (they'll only
        // show it if that conversation is the one currently open); an
        // agent's keystroke relays to that one customer's personal room.
        socket.on('support:typing', ({ conversationId, isTyping, customerId } = {}) => {
            if (!conversationId) return;
            if (isSupportAgent && customerId) {
                io.to(`user_${customerId}`).emit('support:typing', { conversationId, isTyping, from: 'AGENT' });
            } else if (socket.user?.userId) {
                io.to('support_agents').emit('support:typing', {
                    conversationId,
                    isTyping,
                    from: 'USER',
                    customerId: socket.user.userId,
                });
            }
        });
    });

    return io;
};

export const getIO = () => {
    if (!io) {
        throw new Error("Socket.io not initialized!");
    }
    return io;
};
