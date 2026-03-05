const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        // 배열 안에 로컬 주소와 나중에 올릴 내 Github Pages 주소를 모두 넣습니다.
        // ⚠️ "내아이디" 부분을 본인의 진짜 Github 아이디로 변경하세요!
        origin: ["http://localhost:5173", "https://ryooyo.github.io"],
        methods: ["GET", "POST"],
        credentials: true
    }
});

let waitingRoom = [];
let matchTimer = null;
const rooms = {};

// 대기실에 있는 모든 유저에게 상태 갱신 알림
function broadcastWaitingRoom() {
    waitingRoom.forEach(p => {
        io.to(p.socketId).emit('match_update', { players: waitingRoom });
    });
}

// 조건 달성 시 실제 게임 방 생성
function startMatch(players) {
    const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    rooms[roomId] = {
        players: players,
        currentTurnIndex: 0,
        gameState: 'playing'
    };

    players.forEach(p => {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.join(roomId);
    });

    console.log(`[🤝 매칭 성사] 방 번호: ${roomId} | 인원: ${players.length}명`);

    io.to(roomId).emit('match_found', {
        roomId: roomId,
        players: players,
        message: "게임을 시작합니다!"
    });
}

io.on('connection', (socket) => {
    console.log(`[🟢 접속됨] 플레이어 ID: ${socket.id}`);

    // ==========================================
    // 1. 매칭 시스템 (15초 타이머 및 2~4인 룰)
    // ==========================================
    socket.on('request_match', (playerData) => {
        console.log(`[🔎 매칭 요청] ${playerData.name} (${socket.id})`);

        // 이미 대기열에 있는지 확인 (중복 방지)
        const isAlreadyWaiting = waitingRoom.some(p => p.socketId === socket.id);
        if (isAlreadyWaiting) return;

        const playerInfo = { ...playerData, socketId: socket.id };
        waitingRoom.push(playerInfo);
        broadcastWaitingRoom();

        if (waitingRoom.length === 1) {
            // 첫 번째 유저가 들어오면 15초 카운트다운 시작
            let timeLeft = 15;
            matchTimer = setInterval(() => {
                timeLeft--;
                waitingRoom.forEach(p => io.to(p.socketId).emit('match_timer_tick', { timeLeft }));

                if (timeLeft <= 0) {
                    clearInterval(matchTimer);
                    matchTimer = null;

                    if (waitingRoom.length >= 2) {
                        // 15초 끝, 2명 이상이면 모인 인원끼리 바로 시작
                        startMatch([...waitingRoom]);
                        waitingRoom = [];
                    } else if (waitingRoom.length === 1) {
                        // 15초 끝, 아무도 안 오면 봇 매치 시작하라고 클라이언트에 통보
                        io.to(waitingRoom[0].socketId).emit('start_with_bots');
                        waitingRoom = [];
                    }
                }
            }, 1000);
        } else if (waitingRoom.length >= 4) {
            // 4명이 꽉 차면 15초가 안 됐어도 즉시 시작
            clearInterval(matchTimer);
            matchTimer = null;
            startMatch([...waitingRoom]);
            waitingRoom = [];
        }
    });

    // ==========================================
    // 2. 물리 및 게임 이벤트 중계
    // ==========================================
    socket.on('sync_physics', (data) => {
        socket.to(data.roomId).emit('sync_physics', data);
    });
    socket.on('block_drag_start', (data) => {
        socket.to(data.roomId).emit('opponent_drag_start', data);
    });
    socket.on('block_drop', (data) => {
        socket.to(data.roomId).emit('opponent_drop', data);
    });
    socket.on('player_game_over', (data) => {
        const room = rooms[data.roomId];
        if (room && room.gameState === 'playing') {
            room.gameState = 'gameover';
            io.to(data.roomId).emit('sync_game_over', { loserId: data.loserId, reason: data.reason });
        }
    });
    socket.on('end_turn', (data) => {
        const room = rooms[data.roomId];
        if (room) {
            room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
            io.to(data.roomId).emit('turn_changed', { turnIndex: room.currentTurnIndex });
        }
    });

    // ==========================================
    // 3. 채팅 & 이모티콘 중계
    // ==========================================
    socket.on('send_chat', (data) => {
        // 나를 포함한 방 전체 인원에게 뿌려줌
        io.to(data.roomId).emit('receive_chat', data);
    });

    socket.on('send_emote', (data) => {
        io.to(data.roomId).emit('receive_emote', data);
    });

    // ==========================================
    // 4. 접속 종료 처리
    // ==========================================
    socket.on('disconnect', () => {
        console.log(`[🔴 연결 끊김] 플레이어 ID: ${socket.id}`);

        // 대기실에서 나간 경우
        const idx = waitingRoom.findIndex(p => p.socketId === socket.id);
        if (idx !== -1) {
            waitingRoom.splice(idx, 1);
            broadcastWaitingRoom();
            if (waitingRoom.length === 0 && matchTimer) {
                clearInterval(matchTimer);
                matchTimer = null;
            }
        }

        // 게임 도중 나간 경우
        for (const roomId in rooms) {
            const room = rooms[roomId];
            if (room.gameState === 'playing') {
                const disconnectedPlayer = room.players.find(p => p.socketId === socket.id);
                if (disconnectedPlayer) {
                    room.gameState = 'gameover';
                    io.to(roomId).emit('sync_game_over', {
                        loserId: socket.id,
                        reason: "상대방 연결 끊김"
                    });
                    break;
                }
            }
        }
    });
});

// 환경 변수 PORT가 있으면 그걸 쓰고, 없으면 로컬용 3000 사용
const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => {
    console.log(`🚀 젠가 멀티플레이어 서버 가동 완료 (포트 ${PORT})`);
    console.log(`📡 WebSocket 연결 주소: ws://localhost:${PORT}`);
});
