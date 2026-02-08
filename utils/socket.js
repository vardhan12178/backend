import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';

let io;

export const initSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: {
            origin: process.env.CLIENT_URL || "http://localhost:3000",
            methods: ["GET", "POST"],
            credentials: true
        }
    });

    // Authenticate socket connections via JWT
    io.use((socket, next) => {
        const token =
            socket.handshake.auth?.token ||
            socket.handshake.headers?.cookie
                ?.split('; ')
                .find(c => c.startsWith('jwt_token='))
                ?.split('=')?.[1];

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
        // Admin joins admin room — must be authenticated admin
        socket.on('join_admin', () => {
            const roles = Array.isArray(socket.user?.roles) ? socket.user.roles : [];
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
    });

    return io;
};

export const getIO = () => {
    if (!io) {
        throw new Error("Socket.io not initialized!");
    }
    return io;
};
