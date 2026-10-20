# Recursion

Recursion is a technique in which a function calls itself to solve smaller instances of the same problem. A base case is the condition under which a recursive function returns without calling itself. Every recursive function needs a base case, otherwise it calls itself until the call stack overflows.

The call stack is the region of memory that stores one frame for every active function call. A stack overflow occurs when the call stack runs out of space.

```c
int factorial(int n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}
```

The statement `return n * factorial(n - 1);` multiplies n by the factorial of the smaller number.

Tail recursion is a form of recursion in which the recursive call is the last operation of the function. A compiler can turn tail recursion into a loop, so it uses constant stack space.

Algorithm for binary search using recursion:
1. Compare the key with the middle element of the array.
2. If they are equal, return the middle index.
3. If the key is smaller, search the left half recursively.
4. Otherwise search the right half recursively.

| Basis | Recursion | Iteration |
| --- | --- | --- |
| Termination | It stops at a base case. | It stops when the loop condition fails. |
| Memory | It uses a stack frame for every call. | It uses a fixed amount of memory. |
| Speed | It is slower because of call overhead. | It is faster because there is no call overhead. |
