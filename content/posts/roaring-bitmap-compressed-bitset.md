---
title: "Roaring Bitmap: 압축과 속도를 동시에 잡는 비트셋"
date: 2026-08-12
draft: false
tags: ["데이터구조", "비트맵", "압축", "데이터베이스", "검색엔진", "RoaringBitmap"]
categories: ["Engineering"]
description: "WAH, EWAH, Concise 같은 기존 런-렝스 인코딩 방식보다 수백 배 빠르면서 메모리 효율도 높은 Roaring Bitmap의 구조와 원리 — Apache Lucene, Druid, ClickHouse, Elasticsearch 등 수십 개의 프로덕션 시스템이 선택한 이유"
---

비트셋(Bitset)은 수십억 개의 정수 집합을 다룰 때 등장하는 가장 강력한 도구 중 하나다. 검색엔진의 역색인, 분석 데이터베이스의 집계 쿼리, 스트리밍 시스템의 필터링 — 모두 비트 연산의 속도에 의존한다. 문제는 데이터가 희소(sparse)하거나 클러스터링되어 있을 때 비트셋이 메모리를 과도하게 소비한다는 점이다.

그래서 오랫동안 WAH, EWAH, Concise 같은 런-렝스 인코딩(RLE) 기반의 압축 비트셋이 쓰여왔다. 그런데 SIGMOD 2017에서 발표된 한 연구는 이렇게 결론 냈다.

> "가능한 모든 상황에서 비트맵 압축에는 Roaring을 사용하라. 다른 비트맵 압축 방식은 쓰지 말라."
> — Wang et al., *An Experimental Study of Bitmap Compression vs. Inverted List Compression*

---

## Roaring Bitmap이란

Roaring Bitmap은 압축 비트셋의 새로운 접근이다. 핵심 아이디어는 단순하다: **데이터의 밀도에 따라 저장 방식을 동적으로 선택한다.**

32비트 정수를 다룬다고 하면, 상위 16비트를 기준으로 전체 공간을 65,536개 단위의 청크(chunk)로 나눈다. 각 청크에 대해 데이터의 분포를 보고 세 가지 컨테이너 중 하나를 선택한다.

| 컨테이너 | 언제 사용 | 구조 |
|---------|---------|------|
| Array 컨테이너 | 원소가 4,096개 미만 (희소 데이터) | 정렬된 16비트 정수 배열 |
| Bitmap 컨테이너 | 원소가 4,096개 이상 (밀집 데이터) | 65,536비트 비트맵 |
| Run 컨테이너 | 연속된 구간이 많은 데이터 | (시작, 길이) 쌍의 배열 |

수동 튜닝 없이 자동으로 최적 컨테이너를 선택하기 때문에, 희소·밀집·클러스터 데이터 모두에서 효율적이다.

---

## 왜 기존 RLE 방식보다 빠른가

WAH나 EWAH 같은 전통적인 압축 비트셋은 런-렝스 인코딩 구조상 **임의 접근(random access)이 느리다.** 특정 비트를 찾으려면 앞에서부터 순차적으로 스캔해야 하기 때문이다.

Roaring은 다르다:

- **임의 접근이 O(1)에 가깝다.** 청크 인덱스로 바로 해당 컨테이너를 찾고, 컨테이너 내에서도 배열 이진 탐색이나 비트맵 직접 접근으로 처리한다.
- **집합 연산(AND, OR, ANDNOT)이 네이티브 비트 연산으로 처리된다.** 밀집 청크끼리는 64비트 워드 단위 비트 연산으로 수행하므로 RLE 디코딩 오버헤드가 없다.
- **SIMD 최적화가 가능하다.** 특히 C/C++ 구현인 CRoaring은 AVX2/AVX-512 명령어를 활용해 병렬 비트 연산을 수행한다.

결과적으로 동일한 집합 연산을 EWAH 대비 수백 배 빠르게 처리하는 벤치마크 수치가 반복적으로 보고된다.

---

## 이식 가능한 포맷 명세

Roaring의 또 다른 강점은 **공개된 직렬화 명세(serialization specification)**다. 각 언어별 구현이 동일한 바이너리 포맷을 따르기 때문에, Java로 직렬화한 비트맵을 Go나 Rust에서 그대로 읽을 수 있다.

분산 시스템에서 여러 언어가 혼재하는 환경이나, 비트맵을 디스크에 저장했다가 나중에 다른 언어로 읽어야 하는 상황에서 중요한 특성이다.

---

## 프로덕션 적용 현황

Roaring Bitmap은 학술적 제안에 머물지 않고 업계에서 가장 중요한 데이터 시스템들의 핵심 컴포넌트로 자리잡았다.

- **검색**: Apache Lucene, Elasticsearch
- **분산 분석**: Apache Druid, Apache Spark, Apache Hive, ClickHouse, Apache Pinot, Apache Doris, StarRocks
- **클라우드/엔터프라이즈**: Google Procella(YouTube SQL 엔진), Microsoft VSTS
- **시계열/스트리밍**: InfluxDB, Netflix Atlas, Redpanda, M3
- **기타**: Weaviate(벡터DB), SourceGraph, Apache Kylin, Bleve

이 정도면 사실상 현대 데이터 인프라의 표준 빌딩 블록이라고 봐도 과언이 아니다.

---

## 언어별 구현

13개 이상의 언어 바인딩이 공식적으로 유지관리된다.

| 언어 | 라이브러리 | 비고 |
|------|---------|-----|
| Java | RoaringBitmap | 레퍼런스 구현 |
| C/C++ | CRoaring | SIMD 최적화 |
| Go | roaring | 순수 Go 구현 |
| Rust | roaring-rs | 순수 Rust 포트 |
| Python | PyRoaringBitMap | CRoaring 바인딩 |
| JavaScript | roaring-node | Node.js |
| C# | CRoaring.Net | .NET 바인딩 |
| Swift | SwiftRoaring | Swift 바인딩 |
| Zig | roaring-zig | Zig 바인딩 |
| PostgreSQL | pg_roaringbitmap | 확장 모듈 |
| Redis | redis-roaring | Redis 모듈 |

---

## 간단한 사용 예시

```java
// Java
import org.roaringbitmap.RoaringBitmap;

RoaringBitmap a = RoaringBitmap.bitmapOf(1, 2, 3, 1000);
RoaringBitmap b = RoaringBitmap.bitmapOf(2, 3, 4, 1000);

RoaringBitmap c = RoaringBitmap.and(a, b);
System.out.println(c.getCardinality()); // 3
```

```go
// Go
import "github.com/RoaringBitmap/roaring"

a := roaring.BitmapOf(1, 2, 3, 1000)
b := roaring.BitmapOf(2, 3, 4, 1000)
c := roaring.And(a, b)
fmt.Println(c.GetCardinality()) // 3
```

---

## 언제 Roaring Bitmap을 써야 하는가

비트셋이 필요한 상황이라면 기본적으로 Roaring을 선택하면 된다. 특히 아래 상황에서 효과가 크다.

- **역색인(inverted index)**: 특정 단어가 등장하는 문서 ID 집합 관리
- **집계 쿼리 최적화**: GROUP BY, COUNT DISTINCT, 세그먼트 필터링
- **사용자/이벤트 세그멘테이션**: 수억 명 사용자 중 조건을 만족하는 집합 연산
- **그래프 데이터 처리**: 연결된 노드 집합의 교집합/합집합

단, 데이터가 매우 작거나(수천 개 이하) 연속적인 정수 범위를 균일하게 커버하는 경우라면 단순 비트배열이 더 간단할 수 있다.

---

## 참고

- 공식 사이트: [roaringbitmap.org](https://roaringbitmap.org)
- 연구 논문: *Better bitmap performance with Roaring bitmaps* (Software: Practice and Experience)
- GitHub: [github.com/RoaringBitmap](https://github.com/RoaringBitmap)
- 직렬화 명세: [github.com/RoaringBitmap/RoaringFormatSpec](https://github.com/RoaringBitmap/RoaringFormatSpec)
