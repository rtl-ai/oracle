#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_VERTICES 64
#define CYCLE_LENGTH 8
#define MAX_G6_LINE 1024

typedef struct {
    uint64_t header_lines;
    uint64_t input_graphs;
    uint64_t graph6_roundtrip_verified;
    uint64_t rejected_min_degree_below_2;
    uint64_t rejected_multiple_degree_2_vertices;
    uint64_t rooted_admissible;
    uint64_t ordinary_min_degree_3;
    uint64_t rooted_with_degree_2_exception;
    uint64_t with_validated_c8_witness;
    uint64_t survivors_without_c8_witness;
    uint64_t invalid_witnesses;
    uint64_t malformed_records;
} Stats;

static uint64_t low_mask(int n)
{
    if (n <= 0) return UINT64_C(0);
    if (n >= 64) return UINT64_MAX;
    return (UINT64_C(1) << n) - UINT64_C(1);
}

static int popcount64(uint64_t value)
{
    return __builtin_popcountll(value);
}

static int ctz64(uint64_t value)
{
    return __builtin_ctzll(value);
}

static void set_error(char *buffer, size_t capacity, const char *message)
{
    if (capacity == 0) return;
    snprintf(buffer, capacity, "%s", message);
}

static bool parse_sixbit(unsigned char byte, unsigned *value)
{
    if (byte < 63 || byte > 126) return false;
    *value = (unsigned)(byte - 63);
    return true;
}

static bool encode_graph6(
    const uint64_t adjacency[MAX_VERTICES],
    int n,
    char output[MAX_G6_LINE],
    size_t *output_length,
    char *error,
    size_t error_capacity)
{
    if (n < 0 || n > MAX_VERTICES) {
        set_error(error, error_capacity, "order outside supported range");
        return false;
    }

    size_t position = 0;
    if (n <= 62) {
        output[position++] = (char)(n + 63);
    } else if (n <= 258047) {
        output[position++] = '~';
        output[position++] = (char)(((unsigned)n >> 12U & 63U) + 63U);
        output[position++] = (char)(((unsigned)n >> 6U & 63U) + 63U);
        output[position++] = (char)(((unsigned)n & 63U) + 63U);
    } else {
        set_error(error, error_capacity, "36-bit graph6 order unsupported");
        return false;
    }

    unsigned accumulator = 0;
    unsigned width = 0;
    for (int high = 1; high < n; ++high) {
        for (int low = 0; low < high; ++low) {
            accumulator = (accumulator << 1U)
                | (unsigned)((adjacency[low] >> high) & UINT64_C(1));
            ++width;
            if (width == 6U) {
                if (position >= MAX_G6_LINE) {
                    set_error(error, error_capacity, "graph6 output buffer overflow");
                    return false;
                }
                output[position++] = (char)(accumulator + 63U);
                accumulator = 0;
                width = 0;
            }
        }
    }
    if (width != 0U) {
        accumulator <<= 6U - width;
        if (position >= MAX_G6_LINE) {
            set_error(error, error_capacity, "graph6 output buffer overflow");
            return false;
        }
        output[position++] = (char)(accumulator + 63U);
    }
    *output_length = position;
    return true;
}

static bool decode_graph6(
    const char *record,
    size_t record_length,
    int expected_order,
    uint64_t adjacency[MAX_VERTICES],
    char canonical[MAX_G6_LINE],
    size_t *canonical_length,
    char *error,
    size_t error_capacity)
{
    while (record_length > 0
           && (record[record_length - 1] == '\n' || record[record_length - 1] == '\r')) {
        --record_length;
    }
    if (record_length == 0) {
        set_error(error, error_capacity, "empty graph6 record");
        return false;
    }

    const char *body = record;
    size_t body_length = record_length;
    static const char header[] = ">>graph6<<";
    const size_t header_length = sizeof(header) - 1U;
    if (body_length >= header_length && memcmp(body, header, header_length) == 0) {
        body += header_length;
        body_length -= header_length;
    }
    if (body_length == 0) {
        set_error(error, error_capacity, "header without graph6 body");
        return false;
    }
    if (body[0] == ':' || body[0] == '&') {
        set_error(error, error_capacity, "sparse6/digraph6 is not graph6");
        return false;
    }

    size_t cursor = 0;
    unsigned first = 0;
    if (!parse_sixbit((unsigned char)body[cursor++], &first)) {
        set_error(error, error_capacity, "invalid graph6 order byte");
        return false;
    }

    uint64_t order = 0;
    if (first <= 62U) {
        order = first;
    } else {
        if (cursor >= body_length) {
            set_error(error, error_capacity, "truncated graph6 order prefix");
            return false;
        }
        unsigned second = 0;
        if (!parse_sixbit((unsigned char)body[cursor], &second)) {
            set_error(error, error_capacity, "invalid graph6 order byte");
            return false;
        }
        if (second != 63U) {
            if (cursor + 3U > body_length) {
                set_error(error, error_capacity, "truncated 18-bit graph6 order");
                return false;
            }
            unsigned a = 0, b = 0, c = 0;
            if (!parse_sixbit((unsigned char)body[cursor], &a)
                || !parse_sixbit((unsigned char)body[cursor + 1U], &b)
                || !parse_sixbit((unsigned char)body[cursor + 2U], &c)) {
                set_error(error, error_capacity, "invalid 18-bit graph6 order byte");
                return false;
            }
            order = ((uint64_t)a << 12U) | ((uint64_t)b << 6U) | (uint64_t)c;
            cursor += 3U;
            if (order < 63U) {
                set_error(error, error_capacity, "noncanonical graph6 order encoding");
                return false;
            }
        } else {
            set_error(error, error_capacity, "36-bit graph6 order unsupported");
            return false;
        }
    }

    if (order > MAX_VERTICES) {
        set_error(error, error_capacity, "graph order exceeds 64-bit representation");
        return false;
    }
    const int n = (int)order;
    if (expected_order >= 0 && n != expected_order) {
        set_error(error, error_capacity, "unexpected graph order");
        return false;
    }

    const size_t edge_bits = (size_t)n * (size_t)(n - 1) / 2U;
    const size_t payload_chars = (edge_bits + 5U) / 6U;
    if (body_length - cursor != payload_chars) {
        set_error(error, error_capacity, "wrong graph6 payload length");
        return false;
    }

    for (int vertex = 0; vertex < MAX_VERTICES; ++vertex) adjacency[vertex] = 0;
    size_t bit_index = 0;
    for (int high = 1; high < n; ++high) {
        for (int low = 0; low < high; ++low) {
            unsigned value = 0;
            if (!parse_sixbit((unsigned char)body[cursor + bit_index / 6U], &value)) {
                set_error(error, error_capacity, "invalid graph6 payload byte");
                return false;
            }
            const unsigned bit = (value >> (5U - (unsigned)(bit_index % 6U))) & 1U;
            ++bit_index;
            if (bit != 0U) {
                adjacency[low] |= UINT64_C(1) << high;
                adjacency[high] |= UINT64_C(1) << low;
            }
        }
    }

    if (edge_bits % 6U != 0U && payload_chars > 0U) {
        unsigned last = 0;
        if (!parse_sixbit((unsigned char)body[body_length - 1U], &last)) {
            set_error(error, error_capacity, "invalid final graph6 payload byte");
            return false;
        }
        const unsigned padding = 6U - (unsigned)(edge_bits % 6U);
        if ((last & ((1U << padding) - 1U)) != 0U) {
            set_error(error, error_capacity, "nonzero graph6 padding bits");
            return false;
        }
    }

    if (!encode_graph6(adjacency, n, canonical, canonical_length, error, error_capacity)) {
        return false;
    }
    if (*canonical_length != body_length
        || memcmp(canonical, body, body_length) != 0) {
        set_error(error, error_capacity, "graph6 decode/encode roundtrip mismatch");
        return false;
    }
    return true;
}

static bool validate_cycle8(
    const uint64_t adjacency[MAX_VERTICES],
    int n,
    const int witness[CYCLE_LENGTH])
{
    uint64_t used = 0;
    for (int index = 0; index < CYCLE_LENGTH; ++index) {
        const int vertex = witness[index];
        if (vertex < 0 || vertex >= n) return false;
        const uint64_t bit = UINT64_C(1) << vertex;
        if ((used & bit) != 0) return false;
        used |= bit;
    }
    for (int index = 0; index < CYCLE_LENGTH; ++index) {
        const int left = witness[index];
        const int right = witness[(index + 1) % CYCLE_LENGTH];
        if (((adjacency[left] >> right) & UINT64_C(1)) == 0) return false;
    }
    return true;
}

static bool cycle8_dfs(
    const uint64_t adjacency[MAX_VERTICES],
    int n,
    int root,
    int depth,
    uint64_t allowed,
    uint64_t used,
    int path[CYCLE_LENGTH],
    int witness[CYCLE_LENGTH])
{
    (void)n;
    if (depth == CYCLE_LENGTH) {
        if (((adjacency[path[CYCLE_LENGTH - 1]] >> root) & UINT64_C(1)) == 0) {
            return false;
        }
        memcpy(witness, path, sizeof(int) * CYCLE_LENGTH);
        return true;
    }

    const int last = path[depth - 1];
    uint64_t candidates = adjacency[last] & allowed & ~used;
    if (depth + 1 == CYCLE_LENGTH) {
        candidates &= adjacency[root];
    }
    while (candidates != 0) {
        const uint64_t next_bit = candidates & (~candidates + UINT64_C(1));
        const int next = ctz64(next_bit);
        candidates ^= next_bit;
        path[depth] = next;
        if (cycle8_dfs(
                adjacency,
                n,
                root,
                depth + 1,
                allowed,
                used | next_bit,
                path,
                witness)) {
            return true;
        }
    }
    return false;
}

static bool find_cycle8(
    const uint64_t adjacency[MAX_VERTICES],
    int n,
    int witness[CYCLE_LENGTH])
{
    if (n < CYCLE_LENGTH) return false;
    const uint64_t universe = low_mask(n);
    int path[CYCLE_LENGTH] = {0};
    for (int root = 0; root <= n - CYCLE_LENGTH; ++root) {
        const uint64_t at_or_below_root = low_mask(root + 1);
        const uint64_t allowed = universe & ~at_or_below_root;
        path[0] = root;
        if (cycle8_dfs(
                adjacency,
                n,
                root,
                1,
                allowed,
                UINT64_C(1) << root,
                path,
                witness)) {
            return true;
        }
    }
    return false;
}

static bool write_summary(const char *path, int expected_order, const Stats *stats)
{
    FILE *stream = fopen(path, "w");
    if (stream == NULL) {
        fprintf(stderr, "rooted_prefilter: cannot open summary %s: %s\n", path, strerror(errno));
        return false;
    }
    const int written = fprintf(
        stream,
        "{\n"
        "  \"schema\": \"erdos64-rooted-prefilter-v1\",\n"
        "  \"order\": %d,\n"
        "  \"graph6_roundtrip_verified\": %" PRIu64 ",\n"
        "  \"header_lines\": %" PRIu64 ",\n"
        "  \"input_graphs\": %" PRIu64 ",\n"
        "  \"invalid_witnesses\": %" PRIu64 ",\n"
        "  \"malformed_records\": %" PRIu64 ",\n"
        "  \"ordinary_min_degree_3\": %" PRIu64 ",\n"
        "  \"rejected_min_degree_below_2\": %" PRIu64 ",\n"
        "  \"rejected_multiple_degree_2_vertices\": %" PRIu64 ",\n"
        "  \"rooted_admissible\": %" PRIu64 ",\n"
        "  \"rooted_with_degree_2_exception\": %" PRIu64 ",\n"
        "  \"survivors_without_c8_witness\": %" PRIu64 ",\n"
        "  \"with_validated_c8_witness\": %" PRIu64 "\n"
        "}\n",
        expected_order,
        stats->graph6_roundtrip_verified,
        stats->header_lines,
        stats->input_graphs,
        stats->invalid_witnesses,
        stats->malformed_records,
        stats->ordinary_min_degree_3,
        stats->rejected_min_degree_below_2,
        stats->rejected_multiple_degree_2_vertices,
        stats->rooted_admissible,
        stats->rooted_with_degree_2_exception,
        stats->survivors_without_c8_witness,
        stats->with_validated_c8_witness);
    const bool okay = written >= 0 && fclose(stream) == 0;
    if (!okay) fprintf(stderr, "rooted_prefilter: failed writing summary %s\n", path);
    return okay;
}

static void usage(const char *program)
{
    fprintf(stderr, "Usage: %s --order N --summary PATH\n", program);
}

int main(int argc, char **argv)
{
    int expected_order = -1;
    const char *summary_path = NULL;
    for (int index = 1; index < argc; ++index) {
        if (strcmp(argv[index], "--order") == 0 && index + 1 < argc) {
            char *end = NULL;
            errno = 0;
            const long value = strtol(argv[++index], &end, 10);
            if (errno != 0 || end == argv[index] || *end != '\0'
                || value < 0 || value > MAX_VERTICES) {
                usage(argv[0]);
                return 64;
            }
            expected_order = (int)value;
        } else if (strcmp(argv[index], "--summary") == 0 && index + 1 < argc) {
            summary_path = argv[++index];
        } else {
            usage(argv[0]);
            return 64;
        }
    }
    if (expected_order < 0 || summary_path == NULL) {
        usage(argv[0]);
        return 64;
    }

    Stats stats = {0};
    char *line = NULL;
    size_t capacity = 0;
    ssize_t length = 0;
    uint64_t line_number = 0;
    int status = 0;

    while ((length = getline(&line, &capacity, stdin)) >= 0) {
        ++line_number;
        size_t trimmed = (size_t)length;
        while (trimmed > 0 && (line[trimmed - 1] == '\n' || line[trimmed - 1] == '\r')) {
            --trimmed;
        }
        if (trimmed == 0) {
            fprintf(stderr, "rooted_prefilter: line %" PRIu64 ": empty record\n", line_number);
            ++stats.malformed_records;
            status = 2;
            break;
        }
        if (trimmed == 10U && memcmp(line, ">>graph6<<", 10U) == 0) {
            ++stats.header_lines;
            continue;
        }

        ++stats.input_graphs;
        uint64_t adjacency[MAX_VERTICES];
        char canonical[MAX_G6_LINE];
        size_t canonical_length = 0;
        char error[160];
        if (!decode_graph6(
                line,
                (size_t)length,
                expected_order,
                adjacency,
                canonical,
                &canonical_length,
                error,
                sizeof(error))) {
            fprintf(stderr, "rooted_prefilter: line %" PRIu64 ": %s\n", line_number, error);
            ++stats.malformed_records;
            status = 2;
            break;
        }
        ++stats.graph6_roundtrip_verified;

        int minimum_degree = expected_order;
        int degree_two_count = 0;
        for (int vertex = 0; vertex < expected_order; ++vertex) {
            const int degree = popcount64(adjacency[vertex]);
            if (degree < minimum_degree) minimum_degree = degree;
            if (degree == 2) ++degree_two_count;
        }
        if (minimum_degree < 2) {
            ++stats.rejected_min_degree_below_2;
            continue;
        }
        if (degree_two_count > 1) {
            ++stats.rejected_multiple_degree_2_vertices;
            continue;
        }

        ++stats.rooted_admissible;
        if (degree_two_count == 0) ++stats.ordinary_min_degree_3;
        else ++stats.rooted_with_degree_2_exception;

        int witness[CYCLE_LENGTH] = {0};
        if (find_cycle8(adjacency, expected_order, witness)) {
            if (!validate_cycle8(adjacency, expected_order, witness)) {
                fprintf(stderr, "rooted_prefilter: internal invalid C8 witness at line %" PRIu64 "\n", line_number);
                ++stats.invalid_witnesses;
                status = 3;
                break;
            }
            ++stats.with_validated_c8_witness;
            continue;
        }

        ++stats.survivors_without_c8_witness;
        if (fwrite(canonical, 1, canonical_length, stdout) != canonical_length
            || fputc('\n', stdout) == EOF) {
            fprintf(stderr, "rooted_prefilter: output write failed: %s\n", strerror(errno));
            status = 4;
            break;
        }
    }

    if (ferror(stdin) != 0 && status == 0) {
        fprintf(stderr, "rooted_prefilter: input read failed: %s\n", strerror(errno));
        status = 5;
    }
    free(line);
    if (fflush(stdout) != 0 && status == 0) {
        fprintf(stderr, "rooted_prefilter: output flush failed: %s\n", strerror(errno));
        status = 4;
    }
    if (!write_summary(summary_path, expected_order, &stats) && status == 0) {
        status = 6;
    }
    fprintf(
        stderr,
        "rooted_prefilter: input=%" PRIu64 " rooted=%" PRIu64
        " c8=%" PRIu64 " survivors=%" PRIu64 " status=%d\n",
        stats.input_graphs,
        stats.rooted_admissible,
        stats.with_validated_c8_witness,
        stats.survivors_without_c8_witness,
        status);
    return status;
}
