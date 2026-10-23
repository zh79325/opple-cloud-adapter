#!/usr/bin/env python3
"""
udp-spoof.py —— 欧享家 LAN UDP 全身份伪装实验（破局 SrcIP 会话绑定假说）

此前实验（tools/udp-probe.js）只伪造了 PDU 内 OppleLink.SrcIP 字段，
IP 头真实源地址始终是 Mac 自身（192.168.0.139）。若灯端校验 IP 头源地址
（标准防伪造做法），即可解释全部拒收。本脚本用 raw socket（IP_HDRINCL）
把 IP 层源地址也伪装成 App 手机（192.168.0.108），四重身份对齐：

  1. IP 头源地址        = App 手机 IP（raw socket 伪造）
  2. PDU OppleLink.SrcIP = App 手机 IP
  3. SrcObjectID        = 分组 ID（与 App 抓包一致）
  4. SrcTransNo         = 实时接续 App 广播计数器（--follow）或手动指定

用法（需 sudo，raw socket 权限）：
  sudo python3 tools/udp-spoof.py --trans-no 60            # 手动计数器，发一次
  sudo python3 tools/udp-spoof.py --follow --bright 0      # 监听 App 广播接续计数器
  sudo python3 tools/udp-spoof.py --trans-no 60 --target 192.168.0.139  # 单播灯
验收：发完后观察灯是否实际变化（开关/亮度），与 App 同屏操作对照。
"""
import argparse
import socket
import struct
import sys
import time

APP_IP = "192.168.0.108"
APP_PORT = 55001
BROADCAST = "255.255.255.255"
KEY = b"qazedcwsx1ujmyhntgb9"  # OPUniversalKey（固件 0xa494e 明文同款）


def crc16_xmodem(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def u32b(v: int) -> bytes:
    return struct.pack(">I", v & 0xFFFFFFFF)


def le32(v: int) -> bytes:
    return struct.pack("<I", v & 0xFFFFFFFF)


def ip_to_bytes(ip: str) -> bytes:
    return bytes(int(x) for x in ip.split("."))


def build_pdu(bright: int, cct: int, trans_no: int, msg_type: int,
              group_id: int, src_ip: str, key: bytes = KEY) -> bytes:
    """复刻 tools/udp-probe.js buildStatusPacket（抓包校准过的权威布局）。"""
    plain_append = b"".join([
        le32(0x30000100), le32(group_id),
        le32(1), le32(1), le32(0x0004FFFF), le32(5), le32(1), le32(0), le32(1), le32(6),
        le32(bright), le32(7), le32(cct),
    ])
    msg_len = 24 + len(plain_append)
    ipb = ip_to_bytes(src_ip)
    head = b"".join([
        # OppleLink 20B
        ipb, u32b(APP_PORT), bytes([255, 255, 255, 255]), u32b(APP_PORT), u32b(1010),
        # OppleNetwork 80B
        u32b(10101), u32b(0), u32b(104 + len(plain_append)), u32b(1), u32b(2),
        u32b(3), u32b(3), u32b(5),
        u32b(0), u32b(0), u32b(group_id), u32b(0), u32b(0), u32b(0),
        u32b(0), u32b(1), u32b(group_id), u32b(0), u32b(0), u32b(0),
        # OppleSession 16B
        u32b(trans_no), u32b(0xFFFFFFFF), u32b(msg_len), u32b(0),  # CheckSum 占位
        # OppleAppHead 8B
        u32b(msg_type), u32b(0),
    ])
    assert len(head) == 124, len(head)
    crc = crc16_xmodem(head[100:] + plain_append)
    head = head[:112] + u32b(crc) + head[116:]
    enc = bytes(c ^ key[i % len(key)] for i, c in enumerate(plain_append))
    return head + enc


def checksum(data: bytes) -> int:
    if len(data) % 2:
        data += b"\x00"
    s = sum(struct.unpack(f">{len(data)//2}H", data))
    s = (s >> 16) + (s & 0xFFFF)
    s += s >> 16
    return (~s) & 0xFFFF


def send_spoofed(pdu: bytes, src_ip: str, dst_ip: str, sport: int, dport: int) -> None:
    """raw socket + IP_HDRINCL：IP 层源地址=src_ip。"""
    udp = struct.pack(">HHHH", sport, dport, 8 + len(pdu), 0) + pdu
    total = 20 + len(udp)
    ip = struct.pack(">BBHHHBBH", 0x45, 0, total, int(time.time()) & 0xFFFF, 0, 64, 17, 0)
    ip += ip_to_bytes(src_ip) + ip_to_bytes(dst_ip)
    ip = ip[:10] + struct.pack(">H", checksum(ip)) + ip[12:]
    s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_RAW)
    s.setsockopt(socket.IPPROTO_IP, socket.IP_HDRINCL, 1)
    s.sendto(ip + udp, (dst_ip, dport))
    s.close()


def parse_trans_no(pdu: bytes):
    if len(pdu) < 120:
        return None, None
    trans = struct.unpack_from(">I", pdu, 100)[0]
    msg_type = struct.unpack_from(">I", pdu, 116)[0]
    return trans, msg_type


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src-ip", default=APP_IP, help="伪造的 IP 层源地址（默认 App 手机）")
    ap.add_argument("--target", default=BROADCAST, help="目的 IP（默认广播）")
    ap.add_argument("--dport", type=lambda x: int(x, 0), default=55001)
    ap.add_argument("--trans-no", type=int, default=None)
    ap.add_argument("--bright", type=int, default=77)
    ap.add_argument("--cct", type=int, default=5000)
    ap.add_argument("--group", type=lambda x: int(x, 0), default=0x004020A4)
    ap.add_argument("--msg-type", type=lambda x: int(x, 0), default=0x02940000)
    ap.add_argument("--follow", action="store_true", help="监听 App 广播并实时接续 SrcTransNo")
    args = ap.parse_args()

    if args.follow:
        print(f"[*] follow 模式：监听 {args.src_ip} 的广播，接续 SrcTransNo 后立即以同一身份回发控制包")
        rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        rx.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        rx.bind(("0.0.0.0", APP_PORT))
        last = None
        while True:
            pdu, addr = rx.recvfrom(2048)
            trans, mt = parse_trans_no(pdu)
            if trans is None or addr[0] != args.src_ip:
                continue
            print(f"[捕获] {addr} transNo={trans} msgType=0x{mt:08X} len={len(pdu)}")
            if last is not None and trans <= last:
                continue  # 只跟增量
            last = trans
            nxt = trans + 1
            spoof_pdu = build_pdu(args.bright, args.cct, nxt, args.msg_type, args.group, args.src_ip)
            try:
                send_spoofed(spoof_pdu, args.src_ip, args.target, APP_PORT, args.dport)
                print(f"  → 已伪装 {args.src_ip} 发送 transNo={nxt} msgType=0x{args.msg_type:08X} "
                      f"bright={args.bright} cct={args.cct} → {args.target}:{args.dport}（{len(spoof_pdu)}B）")
            except PermissionError:
                sys.exit("权限不足：raw socket 需要 sudo")
            time.sleep(0.2)
    else:
        if args.trans_no is None:
            sys.exit("手动模式需 --trans-no（观察 App 抓包计数器后指定）")
        pdu = build_pdu(args.bright, args.cct, args.trans_no, args.msg_type, args.group, args.src_ip)
        send_spoofed(pdu, args.src_ip, args.target, APP_PORT, args.dport)
        time.sleep(0.1)
        send_spoofed(pdu, args.src_ip, args.target, APP_PORT, args.dport)
        print(f"已伪装 {args.src_ip} → {args.target}:{args.dport} transNo={args.trans_no} "
              f"bright={args.bright} cct={args.cct}（{len(pdu)}B ×2）")
        print("PDU hex:", pdu.hex())


if __name__ == "__main__":
    main()
