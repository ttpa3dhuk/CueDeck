/* Native positive control for the in-process, non-global-IOSurface C ABI. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int cuedeck_gpu_selftest(int flip_y);

int main(int argc, char **argv) {
    int flip = 0;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--flip-y") == 0 && i + 1 < argc) flip = atoi(argv[++i]) ? 1 : 0;
    }
    return cuedeck_gpu_selftest(flip);
}
