# Operating Systems - Unit 3

## Paging

Paging is a memory management scheme that divides physical memory into fixed-size blocks called frames. Logical memory is divided into blocks of the same size called pages. The page table maps each page of a process to a frame in physical memory. Paging avoids external fragmentation because any free frame can hold any page. A translation lookaside buffer is a small fast cache that stores recent page table entries.

## Segmentation

Segmentation divides a program into variable-sized logical units called segments, such as code, data and stack. Each segment has a base address and a limit stored in the segment table. Segmentation suffers from external fragmentation because segments vary in size. A segmentation fault occurs when a process accesses memory outside its segment limit.

## Deadlocks

A deadlock is a situation in which a set of processes wait forever for resources held by each other. Four conditions must hold for a deadlock: mutual exclusion, hold and wait, no preemption and circular wait. The banker's algorithm avoids deadlock by granting a request only when the system stays in a safe state. Deadlock detection builds a wait-for graph and looks for a cycle.

## Scheduling

Round robin scheduling gives each process a fixed time quantum in turn. Shortest job first scheduling picks the process with the smallest next CPU burst. Priority scheduling can cause starvation, which aging prevents by raising the priority of waiting processes. Context switching saves the state of one process and loads the state of another.
