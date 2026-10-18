# Unit III - Authentication and Key Management

## B. Tech CSE Batch 2023-2027 Semester-VII (AY 2026-27)

The slides should be used only for preparing notes, academic purposes (e.g. in teaching a class), and should not be used for commercial purposes. Some of the figures and text are adapted from standard textbooks and their authors are gratefully acknowledged.

## Symmetric and Asymmetric Key Cryptography

In symmetric key cryptography the sender and the receiver share a single secret key, which is used both to encrypt and to decrypt the message. The secret key must be exchanged over a secure channel before any message is sent, and every pair of users needs its own secret key.

In asymmetric key cryptography each user has a public key and a private key. The public key PU e is published so that anyone can encrypt a message for its owner, while the private key is kept secret and is used to decrypt. A digital signature is created with the sender's private key and verified with the sender's public key.

## Simple Secret Key Distribution

In simple secret key distribution, user A generates a public key and a private key and sends the public key to user B together with its identity. B generates a session key K s, encrypts it with A's public key and returns it to A. A decrypts the session key with its private key, and both users then discard the public key and the private key. The scheme is vulnerable to a man-in-the-middle attack because the public key is not authenticated.

## Diffie-Hellman Key Exchange

The Diffie-Hellman key exchange lets two users agree on a shared secret key over an insecure channel. Both users agree on a large prime number q and a primitive root alpha. Each user chooses a private key at random and computes a public key by raising alpha to the private key modulo q. Each user then computes the shared secret key by raising the other user's public key to its own private key modulo q.

The security of the Diffie-Hellman key exchange rests on the difficulty of computing discrete logarithms. Without authentication the exchange is vulnerable to a man-in-the-middle attack, in which an attacker establishes a separate shared key with each user.

## Examples

i. Let q = 23 and alpha = 5. ii. If A has private key 9 what is A's public key? iii. If B has private key 4 what is the shared secret key? A computes key = 5^9 mod 23 and B computes key = 5^4 mod 23.

## Secure Hash Function

A hash function maps a message of any length to a fixed-length hash value, called a message digest. A secure hash function must be one-way, so that the message cannot be recovered from the digest, and collision resistant, so that it is infeasible to find two messages with the same digest.

## Message Digest: MD5 and SHA-1

MD5 produces a 128-bit message digest by processing the message in 512-bit blocks through four rounds. SHA-1 produces a 160-bit message digest and processes the message in 512-bit blocks through eighty steps. Collision attacks have been demonstrated against both MD5 and SHA-1, so they are no longer considered secure.

## Secure Hash Algorithm (SHA)

The Secure Hash Algorithm (SHA) family was published by NIST. SHA-256 produces a 256-bit message digest and SHA-512 produces a 512-bit message digest. SHA-3 is based on the sponge construction rather than on the Merkle-Damgard construction used by SHA-2.

## Simplified Examples of the Use of a Hash Function for Message Authentication

A message authentication code (MAC) is computed from the message and a secret key shared by the sender and the receiver. The receiver recomputes the MAC with the shared secret key and compares it with the MAC it received. A hash value encrypted with the sender's private key provides both message authentication and a digital signature.
