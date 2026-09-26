# Computer Networks - Unit 2

## 1. Introduction to Computer Networks

### 1.1 Network Topologies

A network topology describes the arrangement of nodes and links in a network. In a bus topology every device is attached to a single shared cable called the backbone; it is cheap to install, but a break in the backbone brings down the whole segment and only one device can transmit at a time.

In a star topology every device connects to a central hub or switch. A failure of one cable affects only one device, which makes faults easy to isolate, but the central switch becomes a single point of failure. A ring topology connects each device to exactly two neighbours so that data travels around the ring in one direction, often using a token to decide who may transmit.

A mesh topology provides a dedicated point-to-point link between every pair of devices. A full mesh of n devices needs n(n-1)/2 links, which gives excellent redundancy and fault tolerance but is expensive to cable. Most real networks use a hybrid topology, for example a star of switches whose core is partially meshed.

### 1.2 Types of Networks

Networks are classified by the geographic area they cover. A personal area network (PAN) connects devices around a single person, such as a phone and a smartwatch over Bluetooth, within a range of a few metres.

A local area network (LAN) connects computers within a building or campus. LANs are privately owned, offer high data rates with low error rates, and usually use Ethernet or Wi-Fi. A metropolitan area network (MAN) spans a city and is often used to interconnect the LANs of one organisation across several sites, for example with a fibre ring.

A wide area network (WAN) covers a country or continent and is typically built from leased lines or carrier services operated by telecommunication providers. The Internet is the largest example of a WAN: a network of networks joined by routers. WAN links have higher latency and are usually slower and more expensive per bit than LAN links.

### 1.3 Transmission Media

Transmission media are the physical paths that carry signals between devices. Guided media confine the signal to a physical conductor. Twisted pair cable twists two insulated copper wires together so that electromagnetic interference affects both equally and cancels out; category 6 cable supports gigabit Ethernet over 100 metres.

Coaxial cable has a central conductor surrounded by insulation and a braided shield, giving better noise immunity and was historically used for cable television and early Ethernet. Optical fibre carries data as pulses of light through a glass core using total internal reflection. Fibre offers very high bandwidth, immunity to electromagnetic interference and low attenuation over long distances, which is why it forms the backbone of the Internet.

Unguided media transmit through air or space. Radio waves are omnidirectional and pass through walls, which suits Wi-Fi and cellular networks. Microwaves need line of sight between antennas, and infrared is limited to short ranges inside a room.

## 2. Reference Models

### 2.1 The OSI Reference Model

The Open Systems Interconnection (OSI) model, published by ISO, divides network communication into seven layers. Each layer provides services to the layer above and uses the services of the layer below, which lets each layer be designed and replaced independently.

From the bottom up, the physical layer transmits raw bits over the medium. The data link layer organises bits into frames and handles error detection between adjacent nodes. The network layer routes packets from source to destination across multiple networks. The transport layer provides end-to-end delivery, segmentation and reliability between processes.

The session layer manages dialogues and synchronisation between applications, the presentation layer handles data representation, compression and encryption, and the application layer provides network services directly to user programs. A common mnemonic for the layers from top to bottom is "All People Seem To Need Data Processing".

### 2.2 The TCP/IP Model

The TCP/IP model is the practical architecture on which the Internet is built. It has four layers: the link layer (sometimes called network access), the internet layer, the transport layer and the application layer.

The internet layer corresponds to the OSI network layer and its central protocol is IP, which provides connectionless, best-effort delivery of packets. The transport layer offers TCP for reliable, connection-oriented byte streams and UDP for lightweight, connectionless datagrams. The application layer merges the OSI session, presentation and application layers into one, so protocols such as HTTP and DNS handle their own formatting and session management.

Unlike the OSI model, which was designed before its protocols, the TCP/IP model was written to describe protocols that already existed. This is why TCP/IP won in practice while the OSI model survives mainly as a teaching and reference framework.

### 2.3 Encapsulation

Encapsulation is the process of wrapping data with protocol information as it moves down the layers at the sender. The application produces a message; the transport layer adds a header containing port numbers to form a segment; the network layer adds a header with source and destination IP addresses to form a packet; and the data link layer adds a header and trailer to form a frame.

Each header is read only by the peer layer at the receiver. At the destination the process is reversed in decapsulation: each layer strips its own header, uses the information in it, and passes the remaining payload up to the layer above.

The unit of data therefore has a different name at each layer, called the protocol data unit (PDU): bits at the physical layer, frames at the data link layer, packets at the network layer, and segments for TCP or datagrams for UDP at the transport layer. Header overhead is the price paid for this layered independence.

## 3. Data Link Layer

### 3.1 Framing

The data link layer divides the stream of bits from the physical layer into discrete units called frames, so that errors can be detected and retransmitted per frame rather than for the whole stream. The receiver must be able to tell where each frame begins and ends.

Character count framing places the length of the frame in its header, but a single corrupted count makes the receiver lose synchronisation. Byte stuffing marks the start and end of a frame with a special flag byte and inserts an escape byte before any flag byte that appears in the data. Bit stuffing, used by HDLC, marks frames with the flag pattern 01111110 and inserts a 0 after every five consecutive 1s in the data so that the flag can never appear inside the payload.

Physical layer coding violations can also delimit frames, by using signal patterns that never occur in valid data.

### 3.2 Error Detection and Correction

Transmission errors flip bits, so the data link layer adds redundant bits that let the receiver detect them. A single parity bit makes the number of 1s even or odd; it detects any odd number of bit errors but misses errors that flip two bits.

The checksum adds the data as a sequence of 16-bit words using one's complement arithmetic and sends the complement of the sum; the Internet protocols use it because it is simple to compute in software. The cyclic redundancy check (CRC) treats the frame as a polynomial and divides it by an agreed generator polynomial; the remainder is appended to the frame, and the receiver checks that the whole frame divides evenly. CRC detects all burst errors shorter than the degree of the generator and is implemented in hardware in Ethernet.

Error correction goes further. Hamming codes add enough check bits to locate and correct a single-bit error, which is useful when retransmission is expensive, such as on wireless or deep-space links.

### 3.3 Flow Control

Flow control stops a fast sender from overwhelming a slow receiver. In stop-and-wait protocol the sender transmits one frame and waits for an acknowledgement before sending the next. It is simple but wastes bandwidth when the propagation delay is long, because the link sits idle while the sender waits.

Sliding window protocols allow the sender to have several unacknowledged frames outstanding at once, up to the window size. In Go-Back-N ARQ the receiver accepts frames only in order; when a frame is lost, the sender retransmits that frame and every frame sent after it. In Selective Repeat ARQ the receiver buffers out-of-order frames and the sender retransmits only the frames that were actually lost, which uses bandwidth better at the cost of more buffering.

Link utilisation improves as the window size grows relative to the bandwidth-delay product of the link.

### 3.4 Medium Access Control

When many stations share one channel, a medium access control (MAC) protocol decides who may transmit. In pure ALOHA a station transmits whenever it has data; collisions are frequent and the maximum throughput is about 18 percent. Slotted ALOHA restricts transmissions to the start of time slots, which doubles the maximum throughput to about 37 percent.

Carrier Sense Multiple Access (CSMA) makes stations listen before transmitting. Classic Ethernet used CSMA with Collision Detection (CSMA/CD): a station that detects a collision stops, sends a jam signal and waits a random time chosen by binary exponential backoff before retrying.

Wireless networks cannot reliably detect collisions while transmitting, so Wi-Fi uses CSMA with Collision Avoidance (CSMA/CA). Stations wait a random backoff before transmitting and may reserve the channel with RTS and CTS control frames, which also mitigates the hidden terminal problem.

## 4. Network Layer

### 4.1 IPv4 Addressing

An IPv4 address is a 32-bit number written in dotted decimal notation as four octets, for example 192.168.10.25. Every address has a network part, which identifies the network, and a host part, which identifies an interface on that network.

Classful addressing originally split the address space into classes. Class A addresses start with 0 and use an 8-bit network part, class B start with 10 and use 16 bits, and class C start with 110 and use 24 bits. Class D is reserved for multicast and class E for experimental use. Classful addressing wasted huge numbers of addresses, because an organisation needing 300 hosts had to take a class B block of 65,534.

Some ranges are special. The private ranges 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16 are not routed on the public Internet and are used behind Network Address Translation (NAT). The address 127.0.0.1 is the loopback address, and an address with all host bits set to 1 is the broadcast address of its network.

### 4.2 Subnetting and CIDR

Subnetting borrows bits from the host part of an address to create several smaller networks from one block. The subnet mask marks which bits belong to the network: a mask of 255.255.255.192, written /26, leaves 6 host bits and therefore 64 addresses per subnet, of which 62 are usable because the first is the network address and the last is the broadcast address.

Classless Inter-Domain Routing (CIDR) abandoned fixed classes and allows the network prefix to be any length. Addresses are written with a slash suffix, such as 200.23.16.0/23, and blocks are allocated in sizes that match actual need.

CIDR also enables route aggregation, sometimes called supernetting: a provider holding eight contiguous /24 blocks can advertise them as a single /21 route. Routers choose between overlapping routes by longest prefix match, forwarding a packet along the most specific route that contains its destination address.

### 4.3 Routing Algorithms

Routers use routing algorithms to build the tables that decide where each packet goes next. In distance vector routing each router keeps a table of the best known distance to every destination and periodically shares that whole table with its neighbours, updating its own entries with the Bellman-Ford equation. The Routing Information Protocol (RIP) uses hop count as its metric and treats 16 hops as unreachable.

Distance vector routing suffers from the count-to-infinity problem, where bad news about a failed link spreads slowly; split horizon and poison reverse reduce it. In link state routing every router floods information about its directly connected links to all routers, so each router learns the complete topology and computes shortest paths itself with Dijkstra's algorithm. OSPF is the most widely used link state protocol inside organisations.

Between autonomous systems the Internet uses the Border Gateway Protocol (BGP), a path vector protocol that chooses routes according to policy rather than purely by distance.

### 4.4 IPv6

IPv6 was designed because the 32-bit IPv4 address space is exhausted. IPv6 addresses are 128 bits long and are written as eight groups of four hexadecimal digits separated by colons; leading zeros may be dropped and one run of zero groups may be replaced by a double colon.

The IPv6 header is simplified to a fixed 40 bytes. It removes the header checksum and moves options into extension headers, and routers no longer fragment packets; instead the source performs path MTU discovery. The flow label field lets a sender mark packets that belong to the same flow for special handling.

IPv6 supports stateless address autoconfiguration, so a host can build its own global address from the network prefix advertised by a router. Because the two protocols are not directly compatible, the transition relies on dual stack hosts that run both, tunnelling of IPv6 packets inside IPv4, and translation gateways such as NAT64.

## 5. Transport Layer

### 5.1 TCP and UDP

The transport layer provides process-to-process communication, using port numbers to deliver data to the correct application on a host. Well-known ports below 1024 are assigned to standard services, for example port 80 for HTTP and port 53 for DNS.

The User Datagram Protocol (UDP) is connectionless and unreliable: it adds only port numbers, a length and a checksum to the data, with no handshake, acknowledgements or ordering. Its low overhead suits DNS queries, voice and video streaming and online games, where a late packet is worse than a lost one.

The Transmission Control Protocol (TCP) is connection-oriented and reliable. It numbers every byte with sequence numbers, acknowledges received data, retransmits lost segments after a timeout, delivers bytes in order and performs flow control with a receive window advertised by the receiver. Web browsing, email and file transfer all run over TCP because they need every byte to arrive correctly.

### 5.2 The Three-Way Handshake

TCP establishes a connection with a three-way handshake before any data is exchanged. The client sends a segment with the SYN flag set and an initial sequence number. The server replies with a segment that has both SYN and ACK set, acknowledging the client's sequence number and choosing its own initial sequence number. Finally the client sends an ACK, and the connection is established in both directions.

Random initial sequence numbers protect against old duplicate segments from previous connections and make it harder for an attacker to inject forged segments. A SYN flood attack abuses the handshake by sending many SYN segments without completing it, filling the server's queue of half-open connections; SYN cookies defend against it.

Connections are closed with a four-way exchange of FIN and ACK segments, because each direction is shut down independently. The side that closes first waits in the TIME_WAIT state for twice the maximum segment lifetime.

### 5.3 Congestion Control

Congestion occurs when more traffic is sent into the network than routers can forward, causing queues to overflow and packets to be dropped. TCP controls congestion by limiting its sending rate with a congestion window, in addition to the receiver's advertised window.

A new connection starts in slow start: the congestion window begins at one or a few segments and doubles every round-trip time, growing exponentially until it reaches the slow start threshold. Beyond the threshold TCP enters congestion avoidance and increases the window by only one segment per round-trip time, a linear increase.

When a timeout signals loss, TCP sets the threshold to half the current window and restarts slow start from one segment. When three duplicate acknowledgements arrive, fast retransmit resends the missing segment immediately and fast recovery halves the window instead of collapsing it. This additive increase, multiplicative decrease (AIMD) behaviour produces the characteristic sawtooth pattern of the TCP window.

## 6. Application Layer

### 6.1 Domain Name System

The Domain Name System (DNS) translates human-readable host names such as www.example.com into IP addresses. DNS is a distributed, hierarchical database: root servers sit at the top, below them top-level domain servers for domains such as .com and .in, and below those the authoritative servers for individual domains.

A client asks its local resolver, which performs the lookup on its behalf. In an iterative query each server returns a referral to the next server to ask, while in a recursive query the server contacted takes responsibility for finding the full answer. Resolvers cache answers for the time-to-live set by the authoritative server, which greatly reduces load on the hierarchy.

DNS stores several record types: an A record maps a name to an IPv4 address, an AAAA record to an IPv6 address, a CNAME record gives an alias for another name, an MX record names the mail server for a domain, and an NS record names the authoritative server for a zone. DNS queries normally travel over UDP port 53.

### 6.2 HTTP

The Hypertext Transfer Protocol (HTTP) is the request-response protocol of the web. A client sends a request line containing a method, a path and the protocol version, followed by headers; the server replies with a status line, headers and usually a body.

Common methods are GET to retrieve a resource, POST to submit data, PUT to replace a resource and DELETE to remove one. Status codes are grouped by their first digit: 2xx means success, such as 200 OK; 3xx means redirection, such as 301 Moved Permanently; 4xx means a client error, such as 404 Not Found; and 5xx means a server error.

HTTP is stateless, so each request is independent; cookies let a server recognise a returning client. HTTP/1.0 opened a new TCP connection for every object, HTTP/1.1 introduced persistent connections, and HTTP/2 multiplexes many streams over one connection. HTTPS runs HTTP over TLS to encrypt and authenticate the exchange.

### 6.3 Email Protocols

Electronic mail uses different protocols for sending and for retrieving messages. The Simple Mail Transfer Protocol (SMTP) pushes mail from the sender's mail client to its mail server and then between mail servers, over TCP port 25 or port 587 for submission. SMTP was designed for 7-bit ASCII text, so MIME extensions encode attachments, images and non-English text.

To read mail, a user agent pulls messages from the mailbox on the server. The Post Office Protocol version 3 (POP3) downloads messages to the client and usually deletes them from the server, which suits a single device. The Internet Message Access Protocol (IMAP) keeps messages on the server and synchronises folders and read status across all of a user's devices.

Webmail services such as Gmail use HTTP between the browser and the mail server, but still use SMTP to exchange mail with other mail servers.
