| Field | PIC | Kind | Offset | Bytes | Decimals |
|---|---|---|---|---|---|
| IR-CASE-ID | 9(8) | display | 0 | 8 | 0 |
| IR-CASE-TYPE | X(10) | alnum | 8 | 10 | 0 |
| IR-STATUS | X | alnum | 18 | 1 | 0 |
| IR-SUBMITTED | 9(8) | display | 19 | 8 | 0 |
| IR-HOUSEHOLD | 99 | display | 27 | 2 | 0 |
| IR-DAYS-WAITING | 9(3) | display | 29 | 3 | 0 |
| IR-SCORE | S9(5)V99 | packed | 32 | 4 | 2 |
| IR-DISCOUNT | S9(3)V99 | packed | 36 | 3 | 2 |
| IR-FILLER | X(5) | alnum | 39 | 5 | 0 |
| record | | | | 44 | |
