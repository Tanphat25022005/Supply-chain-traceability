import { useEffect, useState } from 'react'
import { Inbox, Siren, TriangleAlert } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { connectSocket, disconnectSocket, Anomaly, Batch, Transfer } from '../api/client'

interface ToastItem {
  id: string
  message: string
  kind: 'anomaly' | 'recall' | 'transfer'
}

const TOAST_LIFETIME_MS = 6000

export default function RealtimeAlerts() {
  const { token } = useAuth()
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    // The backend now requires a valid access token at the Socket.IO
    // handshake, so there's nothing to connect to before login (or after
    // logout) — this also keeps toasts scoped to being an authenticated user.
    if (!token) {
      disconnectSocket()
      return
    }

    const socket = connectSocket(token)

    const push = (toast: ToastItem) => {
      setToasts((prev) => [...prev, toast])
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toast.id)), TOAST_LIFETIME_MS)
    }

    const onAnomaly = (anomaly: Anomaly) => {
      push({ id: anomaly.id, message: anomaly.message, kind: 'anomaly' })
    }
    const onRecall = (batch: Batch) => {
      push({ id: `recall-${batch.id}-${Date.now()}`, message: `Lô "${batch.productName}" đã bị thu hồi`, kind: 'recall' })
    }

    // A new hand-over reaches the receiver; the receiver's answer reaches the sender.
    const onTransfer = (t: Transfer) => {
      const qty = `${t.quantity.toLocaleString('vi-VN')} ${t.unit}`
      const message =
        t.status === 'PENDING'
          ? `Bạn có hàng được bàn giao (${qty}) — vào "Việc cần làm" để xác nhận`
          : t.status === 'ACCEPTED'
            ? `Bên nhận đã xác nhận nhận ${(t.receivedQuantity ?? t.quantity).toLocaleString('vi-VN')} ${t.unit}`
            : t.status === 'REJECTED'
              ? `Bên nhận từ chối nhận hàng${t.responseReason ? `: ${t.responseReason}` : ''}`
              : `Lần bàn giao ${qty} đã được huỷ`
      push({ id: `transfer-${t.id}-${t.status}`, message, kind: 'transfer' })
    }

    socket.on('anomaly', onAnomaly)
    socket.on('recall', onRecall)
    socket.on('transfer', onTransfer)
    return () => {
      socket.off('anomaly', onAnomaly)
      socket.off('recall', onRecall)
      socket.off('transfer', onTransfer)
    }
  }, [token])

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          className={`rounded-xl px-4 py-3 text-sm shadow-card-hover dark:shadow-none text-white backdrop-blur-sm animate-slide-up flex items-start gap-2 ${
            t.kind === 'recall' ? 'bg-rose-600/95 dark:bg-rose-600/90' : t.kind === 'transfer' ? 'bg-sky-600/95 dark:bg-sky-600/90' : 'bg-amber-500/95 dark:bg-amber-500/90'
          }`}
        >
          {t.kind === 'recall' ? (
            <Siren className="w-4 h-4 flex-shrink-0" />
          ) : t.kind === 'transfer' ? (
            <Inbox className="w-4 h-4 flex-shrink-0" />
          ) : (
            <TriangleAlert className="w-4 h-4 flex-shrink-0" />
          )}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  )
}
